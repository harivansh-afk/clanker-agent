import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessage } from "@mariozechner/companion-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import {
  createVercelStreamListener,
  extractUserText,
} from "../src/core/gateway/vercel-ai-stream.js";

type MessageUpdateSessionEvent = Extract<
  AgentSessionEvent,
  { type: "message_update" }
>;
type MessageEndSessionEvent = Extract<
  AgentSessionEvent,
  { type: "message_end" }
>;
type TurnEndSessionEvent = Extract<AgentSessionEvent, { type: "turn_end" }>;
type TextAssistantMessageEvent = Extract<
  MessageUpdateSessionEvent["assistantMessageEvent"],
  { type: "text_start" | "text_delta" | "text_end" }
>;
type MockResponse = ServerResponse<IncomingMessage> & {
  chunks: string[];
  ended: boolean;
};

describe("extractUserText", () => {
  it("extracts text from useChat v5+ format with parts", () => {
    const body = {
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello world" }] },
      ],
    };
    expect(extractUserText(body)).toBe("hello world");
  });

  it("extracts text from useChat v4 format with content string", () => {
    const body = {
      messages: [{ role: "user", content: "hello world" }],
    };
    expect(extractUserText(body)).toBe("hello world");
  });

  it("extracts last user message when multiple messages present", () => {
    const body = {
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "assistant", parts: [{ type: "text", text: "response" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    };
    expect(extractUserText(body)).toBe("second");
  });

  it("extracts text from simple gateway format", () => {
    expect(extractUserText({ text: "hello" })).toBe("hello");
  });

  it("extracts text from prompt format", () => {
    expect(extractUserText({ prompt: "hello" })).toBe("hello");
  });

  it("returns null for empty body", () => {
    expect(extractUserText({})).toBeNull();
  });

  it("returns null for empty messages array", () => {
    expect(extractUserText({ messages: [] })).toBeNull();
  });

  it("prefers text field over messages", () => {
    const body = {
      text: "direct",
      messages: [
        { role: "user", parts: [{ type: "text", text: "from messages" }] },
      ],
    };
    expect(extractUserText(body)).toBe("direct");
  });
});

describe("createVercelStreamListener", () => {
  function createAssistantMessage(text: string): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "mock",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  function createMockResponse(): MockResponse {
    const chunks: string[] = [];
    let ended = false;
    const response = {
      get writableEnded() {
        return ended;
      },
      write(data: string) {
        chunks.push(data);
        return true;
      },
      end() {
        ended = true;
      },
      chunks,
      get ended() {
        return ended;
      },
    } as unknown as MockResponse;
    return response;
  }

  function createMessageUpdateEvent(
    assistantMessageEvent: TextAssistantMessageEvent,
  ): MessageUpdateSessionEvent {
    return {
      type: "message_update",
      message: createAssistantMessage(""),
      assistantMessageEvent,
    };
  }

  function createAssistantMessageEndEvent(
    text: string,
  ): MessageEndSessionEvent {
    return {
      type: "message_end",
      message: createAssistantMessage(text),
    };
  }

  function createTurnEndEvent(): TurnEndSessionEvent {
    return {
      type: "turn_end",
      message: createAssistantMessage(""),
      toolResults: [],
    };
  }

  function parseChunks(chunks: string[]): Array<object | string> {
    return chunks
      .filter((c) => c.startsWith("data: "))
      .map((c) => {
        const payload = c.replace(/^data: /, "").replace(/\n\n$/, "");
        try {
          return JSON.parse(payload);
        } catch {
          return payload;
        }
      });
  }

  it("translates text streaming events", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener(
      createMessageUpdateEvent({
        type: "text_start",
        contentIndex: 0,
        partial: createAssistantMessage(""),
      }),
    );
    listener(
      createMessageUpdateEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: createAssistantMessage("hello"),
      }),
    );
    listener(
      createMessageUpdateEvent({
        type: "text_end",
        contentIndex: 0,
        content: "hello",
        partial: createAssistantMessage("hello"),
      }),
    );
    listener(createTurnEndEvent());

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
      { type: "text-start", id: "text_0" },
      { type: "text-delta", id: "text_0", delta: "hello" },
      { type: "text-end", id: "text_0" },
      { type: "finish-step" },
    ]);
  });

  it("flushes final assistant text from message_end when no deltas streamed", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener(createAssistantMessageEndEvent("final answer"));
    listener(createTurnEndEvent());

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
      { type: "text-start", id: "text_0" },
      { type: "text-delta", id: "text_0", delta: "final answer" },
      { type: "text-end", id: "text_0" },
      { type: "finish-step" },
    ]);
  });

  it("flushes the missing text suffix on message_end", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener(
      createMessageUpdateEvent({
        type: "text_start",
        contentIndex: 0,
        partial: createAssistantMessage(""),
      }),
    );
    listener(
      createMessageUpdateEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hel",
        partial: createAssistantMessage("hel"),
      }),
    );
    listener(createAssistantMessageEndEvent("hello"));
    listener(createTurnEndEvent());

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
      { type: "text-start", id: "text_0" },
      { type: "text-delta", id: "text_0", delta: "hel" },
      { type: "text-delta", id: "text_0", delta: "lo" },
      { type: "text-end", id: "text_0" },
      { type: "finish-step" },
    ]);
  });

  it("flushes text_end content before closing the block", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener(
      createMessageUpdateEvent({
        type: "text_start",
        contentIndex: 0,
        partial: createAssistantMessage(""),
      }),
    );
    listener(
      createMessageUpdateEvent({
        type: "text_end",
        contentIndex: 0,
        content: "hello",
        partial: createAssistantMessage("hello"),
      }),
    );
    listener(createAssistantMessageEndEvent("hello"));
    listener(createTurnEndEvent());

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
      { type: "text-start", id: "text_0" },
      { type: "text-delta", id: "text_0", delta: "hello" },
      { type: "text-end", id: "text_0" },
      { type: "finish-step" },
    ]);
  });

  it("closes an open text block when final text mismatches the streamed prefix", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener(
      createMessageUpdateEvent({
        type: "text_start",
        contentIndex: 0,
        partial: createAssistantMessage(""),
      }),
    );
    listener(
      createMessageUpdateEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: createAssistantMessage("hello"),
      }),
    );
    listener(createAssistantMessageEndEvent("goodbye"));
    listener(createTurnEndEvent());

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
      { type: "text-start", id: "text_0" },
      { type: "text-delta", id: "text_0", delta: "hello" },
      { type: "text-end", id: "text_0" },
      { type: "finish-step" },
    ]);
  });

  it("does not write after response has ended", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({ type: "agent_start" } as AgentSessionEvent);
    response.end();
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([{ type: "start", messageId: "test-msg-id" }]);
  });

  it("ignores events outside the active prompt lifecycle", () => {
    const response = createMockResponse();
    const listener = createVercelStreamListener(response, "test-msg-id");

    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener({ type: "agent_start" } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    } as AgentSessionEvent);
    listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
    listener({
      type: "turn_start",
      turnIndex: 1,
      timestamp: Date.now(),
    } as AgentSessionEvent);

    const parsed = parseChunks(response.chunks);
    expect(parsed).toEqual([
      { type: "start", messageId: "test-msg-id" },
      { type: "start-step" },
    ]);
  });
});
