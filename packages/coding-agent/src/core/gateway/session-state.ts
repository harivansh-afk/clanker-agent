import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { HistoryMessage, HistoryPart } from "./types.js";

export interface GatewayTransientToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  timestamp: number;
}

function isSupportedHistoryRole(
  role: AgentMessage["role"],
): role is "user" | "assistant" | "toolResult" {
  return role === "user" || role === "assistant" || role === "toolResult";
}

function historyMessageId(message: AgentMessage, index: number): string {
  return `${message.timestamp}-${message.role}-${index}`;
}

function transientAssistantId(
  sessionKey: string,
  message: AgentMessage | null,
): string {
  return `draft:${sessionKey}:${message?.timestamp ?? 0}`;
}

function transientToolResultId(sessionKey: string, toolCallId: string): string {
  return `draft-tool:${sessionKey}:${toolCallId}`;
}

export function messageContentToHistoryParts(msg: AgentMessage): HistoryPart[] {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (contentPart): contentPart is { type: "text"; text: string } =>
            typeof contentPart === "object" &&
            contentPart !== null &&
            contentPart.type === "text",
        )
        .map((contentPart) => ({
          type: "text" as const,
          text: contentPart.text,
        }));
    }
    return [];
  }

  if (msg.role === "assistant") {
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const parts: HistoryPart[] = [];
    for (const contentPart of content) {
      if (typeof contentPart !== "object" || contentPart === null) {
        continue;
      }
      if (contentPart.type === "text") {
        parts.push({
          type: "text",
          text: (contentPart as { type: "text"; text: string }).text,
        });
      } else if (contentPart.type === "thinking") {
        parts.push({
          type: "reasoning",
          text: (contentPart as { type: "thinking"; thinking: string })
            .thinking,
        });
      } else if (contentPart.type === "toolCall") {
        const toolCall = contentPart as {
          type: "toolCall";
          id: string;
          name: string;
          arguments: unknown;
        };
        parts.push({
          type: "tool-invocation",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          state: "call",
        });
      }
    }
    return parts;
  }

  if (msg.role === "toolResult") {
    const toolResult = msg as {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError: boolean;
    };
    const textParts = Array.isArray(toolResult.content)
      ? (toolResult.content as { type: string; text?: string }[])
          .filter((contentPart) => {
            return (
              contentPart.type === "text" &&
              typeof contentPart.text === "string"
            );
          })
          .map((contentPart) => contentPart.text as string)
          .join("")
      : "";

    return [
      {
        type: "tool-invocation",
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        args: undefined,
        state: toolResult.isError ? "error" : "result",
        result: textParts,
      },
    ];
  }

  return [];
}

export function buildGatewaySessionStateMessages(params: {
  sessionKey: string;
  rawMessages: AgentMessage[];
  activeAssistantMessage: AgentMessage | null;
  pendingToolResults: GatewayTransientToolResult[];
}): HistoryMessage[] {
  const {
    sessionKey,
    rawMessages,
    activeAssistantMessage,
    pendingToolResults,
  } = params;
  const messages: HistoryMessage[] = [];
  const persistedToolCallIds = new Set<string>();

  for (const [index, message] of rawMessages.entries()) {
    if (!isSupportedHistoryRole(message.role)) {
      continue;
    }

    if (
      message.role === "toolResult" &&
      typeof (message as { toolCallId?: unknown }).toolCallId === "string"
    ) {
      persistedToolCallIds.add((message as { toolCallId: string }).toolCallId);
    }

    messages.push({
      id: historyMessageId(message, index),
      role: message.role,
      parts: messageContentToHistoryParts(message),
      timestamp: message.timestamp,
    });
  }

  if (activeAssistantMessage?.role === "assistant") {
    messages.push({
      id: transientAssistantId(sessionKey, activeAssistantMessage),
      role: "assistant",
      parts: messageContentToHistoryParts(activeAssistantMessage),
      timestamp: activeAssistantMessage.timestamp ?? Date.now(),
    });
  }

  for (const pendingToolResult of pendingToolResults) {
    if (persistedToolCallIds.has(pendingToolResult.toolCallId)) {
      continue;
    }

    messages.push({
      id: transientToolResultId(sessionKey, pendingToolResult.toolCallId),
      role: "toolResult",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: pendingToolResult.toolCallId,
          toolName: pendingToolResult.toolName,
          args: undefined,
          state: pendingToolResult.isError ? "error" : "result",
          result: pendingToolResult.result,
        },
      ],
      timestamp: pendingToolResult.timestamp,
    });
  }

  return messages;
}
