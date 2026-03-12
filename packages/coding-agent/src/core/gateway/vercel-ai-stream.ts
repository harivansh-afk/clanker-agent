import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AgentSessionEvent } from "../agent-session.js";
import type { GatewayEvent } from "./internal-types.js";

type TextStreamState = {
  started: boolean;
  ended: boolean;
  streamedText: string;
};

function isTextContent(
  value: unknown,
): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "text" in value &&
    (value as { type: unknown }).type === "text" &&
    typeof (value as { text: unknown }).text === "string"
  );
}

function getAssistantTextParts(
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
): Array<{ contentIndex: number; text: string }> {
  if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) {
    return [];
  }

  const textParts: Array<{ contentIndex: number; text: string }> = [];
  for (const [contentIndex, content] of event.message.content.entries()) {
    if (!isTextContent(content) || content.text.length === 0) {
      continue;
    }
    textParts.push({ contentIndex, text: content.text });
  }

  return textParts;
}

/**
 * Write a single Vercel AI SDK v5+ SSE chunk to the response.
 * Format: `data: <JSON>\n\n`
 * For the terminal [DONE] sentinel: `data: [DONE]\n\n`
 */
function writeChunk(response: ServerResponse, chunk: object | string): void {
  if (response.writableEnded) return;
  const payload = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
  response.write(`data: ${payload}\n\n`);
}

/**
 * Extract the user's text from the request body.
 * Supports both useChat format ({ messages: UIMessage[] }) and simple gateway format ({ text: string }).
 */
export function extractUserText(body: Record<string, unknown>): string | null {
  // Simple gateway format
  if (typeof body.text === "string" && body.text.trim()) {
    return body.text;
  }
  // Convenience format
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt;
  }
  // Vercel AI SDK useChat format - extract last user message
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i] as Record<string, unknown>;
      if (msg.role !== "user") continue;
      // v5+ format with parts array
      if (Array.isArray(msg.parts)) {
        for (const part of msg.parts as Array<Record<string, unknown>>) {
          if (part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
        }
      }
      // v4 format with content string
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content;
      }
    }
  }
  return null;
}

/**
 * Create an AgentSessionEvent listener that translates events to Vercel AI SDK v5+ SSE
 * chunks and writes them to the HTTP response.
 *
 * Returns the listener function. The caller is responsible for subscribing/unsubscribing.
 */
export function createVercelStreamListener(
  response: ServerResponse,
  messageId?: string,
): (event: AgentSessionEvent) => void {
  // Gate: only forward events within a single prompt's agent_start -> agent_end lifecycle.
  // handleChat now subscribes this listener immediately before the queued prompt starts,
  // so these guards only need to bound the stream to that prompt's event span.
  let active = false;
  const msgId = messageId ?? randomUUID();
  let textStates = new Map<number, TextStreamState>();

  const getTextState = (contentIndex: number): TextStreamState => {
    const existing = textStates.get(contentIndex);
    if (existing) {
      return existing;
    }
    const initial: TextStreamState = {
      started: false,
      ended: false,
      streamedText: "",
    };
    textStates.set(contentIndex, initial);
    return initial;
  };

  const emitTextStart = (contentIndex: number): void => {
    const state = getTextState(contentIndex);
    if (state.started) {
      return;
    }
    writeChunk(response, {
      type: "text-start",
      id: `text_${contentIndex}`,
    });
    state.started = true;
  };

  const emitTextDelta = (contentIndex: number, delta: string): void => {
    const state = getTextState(contentIndex);
    if (delta.length === 0 || state.ended) {
      return;
    }
    emitTextStart(contentIndex);
    writeChunk(response, {
      type: "text-delta",
      id: `text_${contentIndex}`,
      delta,
    });
    state.streamedText += delta;
  };

  const emitTextEnd = (contentIndex: number): void => {
    const state = getTextState(contentIndex);
    if (state.ended) {
      return;
    }
    emitTextStart(contentIndex);
    writeChunk(response, {
      type: "text-end",
      id: `text_${contentIndex}`,
    });
    state.ended = true;
  };

  const flushTextPart = (
    contentIndex: number,
    fullText: string,
    close: boolean,
  ): void => {
    const state = getTextState(contentIndex);
    if (state.ended) {
      return;
    }
    if (!fullText.startsWith(state.streamedText)) {
      if (close && state.started) {
        emitTextEnd(contentIndex);
      }
      return;
    }

    const suffix = fullText.slice(state.streamedText.length);
    if (suffix.length > 0) {
      emitTextDelta(contentIndex, suffix);
    }
    if (close) {
      emitTextEnd(contentIndex);
    }
  };

  const flushAssistantMessageText = (
    event: Extract<AgentSessionEvent, { type: "message_end" }>,
  ): void => {
    for (const part of getAssistantTextParts(event)) {
      flushTextPart(part.contentIndex, part.text, true);
    }
  };

  return (event: AgentSessionEvent) => {
    if (response.writableEnded) return;

    // Activate on our agent_start, deactivate on agent_end
    if (event.type === "agent_start") {
      if (!active) {
        active = true;
        writeChunk(response, { type: "start", messageId: msgId });
      }
      return;
    }
    if (event.type === "agent_end") {
      active = false;
      return;
    }

    // Drop events that don't belong to our message
    if (!active) return;

    switch (event.type) {
      case "turn_start":
        textStates = new Map();
        writeChunk(response, { type: "start-step" });
        return;

      case "message_update": {
        const inner = event.assistantMessageEvent;
        switch (inner.type) {
          case "text_start":
            emitTextStart(inner.contentIndex);
            return;
          case "text_delta":
            emitTextDelta(inner.contentIndex, inner.delta);
            return;
          case "text_end":
            flushTextPart(inner.contentIndex, inner.content, true);
            return;
          case "toolcall_start": {
            const content = inner.partial.content[inner.contentIndex];
            if (content?.type === "toolCall") {
              writeChunk(response, {
                type: "tool-input-start",
                toolCallId: content.id,
                toolName: content.name,
              });
            }
            return;
          }
          case "toolcall_delta": {
            const content = inner.partial.content[inner.contentIndex];
            if (content?.type === "toolCall") {
              writeChunk(response, {
                type: "tool-input-delta",
                toolCallId: content.id,
                inputTextDelta: inner.delta,
              });
            }
            return;
          }
          case "toolcall_end":
            writeChunk(response, {
              type: "tool-input-available",
              toolCallId: inner.toolCall.id,
              toolName: inner.toolCall.name,
              input: inner.toolCall.arguments,
            });
            return;
          case "thinking_start":
            writeChunk(response, {
              type: "reasoning-start",
              id: `reasoning_${inner.contentIndex}`,
            });
            return;
          case "thinking_delta":
            writeChunk(response, {
              type: "reasoning-delta",
              id: `reasoning_${inner.contentIndex}`,
              delta: inner.delta,
            });
            return;
          case "thinking_end":
            writeChunk(response, {
              type: "reasoning-end",
              id: `reasoning_${inner.contentIndex}`,
            });
            return;
        }
        return;
      }

      case "message_end":
        if (event.message.role === "assistant") {
          flushAssistantMessageText(event);
        }
        return;

      case "turn_end":
        writeChunk(response, { type: "finish-step" });
        return;

      case "tool_execution_end":
        writeChunk(response, {
          type: "tool-output-available",
          toolCallId: event.toolCallId,
          output: event.result,
        });
        return;
    }
  };
}

/**
 * Write the terminal finish sequence and end the response.
 */
export function finishVercelStream(
  response: ServerResponse,
  finishReason: string = "stop",
): void {
  if (response.writableEnded) return;
  writeChunk(response, { type: "finish", finishReason });
  writeChunk(response, "[DONE]");
  response.end();
}

/**
 * Write an error chunk and end the response.
 */
export function errorVercelStream(
  response: ServerResponse,
  errorText: string,
): void {
  if (response.writableEnded) return;
  writeChunk(response, { type: "error", errorText });
  writeChunk(response, "[DONE]");
  response.end();
}

/**
 * Create a GatewayEvent listener that forwards `structured_part` events to the
 * response as custom SSE chunks. Returns the listener function so the caller
 * can subscribe it to managedSession.listeners and unsubscribe on cleanup.
 */
export function createGatewayStructuredPartListener(
  response: ServerResponse,
): (event: GatewayEvent) => void {
  return (event: GatewayEvent) => {
    if (response.writableEnded) return;
    if (event.type !== "structured_part") return;
    writeChunk(response, {
      type: "structured-part",
      partType: event.partType,
      payload: event.payload,
    });
  };
}
