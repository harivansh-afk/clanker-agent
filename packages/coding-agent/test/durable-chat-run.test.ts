import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableChatRunReporter } from "../src/core/gateway/durable-chat-run.js";

const originalConvexUrl = process.env.CONVEX_URL;
const originalConvexSecret = process.env.CONVEX_SECRET;

function mockOkResponse() {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response;
}

describe("DurableChatRunReporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = originalConvexUrl;
    }
    if (originalConvexSecret === undefined) {
      delete process.env.CONVEX_SECRET;
    } else {
      process.env.CONVEX_SECRET = originalConvexSecret;
    }
  });

  it("upserts a single assistant message with tool results and completes the run", async () => {
    process.env.CONVEX_URL = "https://convex.example";
    process.env.CONVEX_SECRET = "test-secret";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mockOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new DurableChatRunReporter({
      runId: "run-1",
      userId: "user-1",
      agentId: "agent-1",
      threadId: "thread-1",
      sessionKey: "session-1",
    });

    const assistantMessage = {
      role: "assistant",
      timestamp: 111,
      content: [{ type: "text", text: "hello from the sandbox" }],
    };

    reporter.handleSessionEvent(
      {
        type: "message_start",
        message: assistantMessage,
      } as never,
      [],
    );
    reporter.handleSessionEvent(
      {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello from the sandbox",
          contentIndex: 0,
        },
      } as never,
      [],
    );
    reporter.handleSessionEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { stdout: "done" },
        isError: false,
      } as never,
      [
        {
          toolCallId: "call-1",
          toolName: "bash",
          result: { stdout: "done" },
          isError: false,
          timestamp: 222,
        },
      ],
    );

    await reporter.finalize({
      ok: true,
      response: "hello from the sandbox",
      sessionKey: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://convex.example/api/chat/run-messages",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://convex.example/api/chat/complete-run",
    );

    const runMessagesBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as {
      items: Array<{
        role: string;
        idempotencyKey: string;
        partsJson: string;
      }>;
    };
    expect(runMessagesBody.items).toHaveLength(1);
    expect(runMessagesBody.items[0]).toMatchObject({
      role: "assistant",
      idempotencyKey: "run:run-1:assistant",
    });
    expect(JSON.parse(runMessagesBody.items[0]?.partsJson ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "hello from the sandbox",
        }),
        expect.objectContaining({
          type: "tool-invocation",
          toolCallId: "call-1",
          toolName: "bash",
          state: "result",
          result: { stdout: "done" },
        }),
      ]),
    );
  });

  it("marks aborted runs as interrupted", async () => {
    process.env.CONVEX_URL = "https://convex.example";
    process.env.CONVEX_SECRET = "test-secret";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mockOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new DurableChatRunReporter({
      runId: "run-2",
      userId: "user-1",
      agentId: "agent-1",
      threadId: "thread-1",
      sessionKey: "session-1",
    });

    await reporter.finalize({
      ok: false,
      response: "",
      error: "Session aborted",
      sessionKey: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://convex.example/api/chat/interrupt-run",
    );
  });
});
