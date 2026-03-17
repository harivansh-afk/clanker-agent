import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableChatRunReporter } from "../src/core/gateway/durable-chat-run.js";

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
  });

  it("posts assistant state to the relay and completes the run", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mockOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new DurableChatRunReporter({
      runId: "run-1",
      callbackUrl: "https://web.example/api/chat/runs/run-1/events",
      callbackToken: "callback-token",
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
      "https://web.example/api/chat/runs/run-1/events",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://web.example/api/chat/runs/run-1/events",
    );

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer callback-token",
      "Content-Type": "application/json",
    });

    const runMessagesCall = fetchMock.mock.calls.find((call) =>
      String(call[1]?.body).includes('"items"'),
    );
    const runMessagesBody = JSON.parse(String(runMessagesCall?.[1]?.body)) as {
      items: Array<{
        idempotencyKey: string;
        partsJson: string;
      }>;
    };
    expect(runMessagesBody.items).toHaveLength(1);
    expect(runMessagesBody.items[0]).toMatchObject({
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

    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      final: {
        status: "completed",
      },
    });
  });

  it("accumulates reasoning across multi-step tool use", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mockOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new DurableChatRunReporter({
      runId: "run-3",
      callbackUrl: "https://web.example/api/chat/runs/run-3/events",
      callbackToken: "callback-token",
    });

    const step1Message = {
      role: "assistant",
      timestamp: 100,
      content: [
        { type: "thinking", thinking: "step 1 reasoning" },
        { type: "text", text: "step 1 text" },
      ],
    };

    reporter.handleSessionEvent(
      { type: "message_start", message: step1Message } as never,
      [],
    );
    reporter.handleSessionEvent(
      { type: "message_end", message: step1Message } as never,
      [],
    );

    const step2Message = {
      role: "assistant",
      timestamp: 200,
      content: [
        { type: "thinking", thinking: "step 2 reasoning" },
        { type: "text", text: "step 2 text" },
      ],
    };

    reporter.handleSessionEvent(
      { type: "message_start", message: step2Message } as never,
      [],
    );
    reporter.handleSessionEvent(
      { type: "message_end", message: step2Message } as never,
      [],
    );

    await reporter.finalize({
      ok: true,
      response: "step 2 text",
      sessionKey: "session-1",
    });

    const itemsCall = fetchMock.mock.calls.find((call) =>
      String(call[1]?.body).includes('"items"'),
    );
    const body = JSON.parse(String(itemsCall?.[1]?.body)) as {
      items: Array<{ partsJson: string }>;
    };
    const parts = JSON.parse(body.items[0]?.partsJson ?? "[]") as Array<{
      type: string;
      text?: string;
    }>;

    const reasoningParts = parts.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(2);
    expect(reasoningParts[0]?.text).toBe("step 1 reasoning");
    expect(reasoningParts[1]?.text).toBe("step 2 reasoning");
  });

  it("marks aborted runs as interrupted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(mockOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new DurableChatRunReporter({
      runId: "run-2",
      callbackUrl: "https://web.example/api/chat/runs/run-2/events",
      callbackToken: "callback-token",
    });

    await reporter.finalize({
      ok: false,
      response: "",
      error: "Session aborted",
      sessionKey: "session-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://web.example/api/chat/runs/run-2/events",
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      final: {
        status: "interrupted",
      },
    });
  });
});
