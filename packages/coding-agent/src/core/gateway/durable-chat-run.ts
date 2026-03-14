import type { AgentMessage } from "@mariozechner/companion-agent-core";
import type { AgentSessionEvent } from "../agent-session.js";
import { extractMessageText } from "./helpers.js";
import { messageContentToHistoryParts } from "./session-state.js";
import type { GatewayTransientToolResult } from "./session-state.js";
import type { GatewayMessageResult, GatewayMessageRequest } from "./types.js";

const FLUSH_INTERVAL_MS = 500;

type PersistHistoryItem = {
  role: "user" | "assistant" | "toolResult";
  text?: string;
  partsJson: string;
  timestamp: number;
  idempotencyKey: string;
};

type ConvexRunStatus = "completed" | "failed" | "interrupted";

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
}

function readConvexSiteUrl(): string | null {
  const raw =
    process.env.CONVEX_SITE_URL ??
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    process.env.CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readConvexSecret(): string | null {
  const raw = process.env.CONVEX_SECRET;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export class DurableChatRunReporter {
  private readonly assistantMessageId: string;
  private readonly convexSiteUrl: string;
  private readonly convexSecret: string;
  private latestAssistantMessage: AgentMessage | null = null;
  private readonly knownToolResults = new Map<
    string,
    GatewayTransientToolResult
  >();
  private flushTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private flushFailure: Error | null = null;

  constructor(
    private readonly durableRun: NonNullable<
      GatewayMessageRequest["durableRun"]
    >,
  ) {
    const convexSiteUrl = readConvexSiteUrl();
    const convexSecret = readConvexSecret();
    if (!convexSiteUrl || !convexSecret) {
      throw new Error(
        "Durable chat run reporting requires CONVEX_SITE_URL/CONVEX_URL and CONVEX_SECRET",
      );
    }
    this.convexSiteUrl = convexSiteUrl;
    this.convexSecret = convexSecret;
    this.assistantMessageId = `run:${durableRun.runId}:assistant`;
  }

  handleSessionEvent(
    event: AgentSessionEvent,
    pendingToolResults: GatewayTransientToolResult[],
  ): void {
    for (const toolResult of pendingToolResults) {
      this.knownToolResults.set(toolResult.toolCallId, toolResult);
    }

    if (event.type === "message_start" && event.message.role === "assistant") {
      this.latestAssistantMessage = event.message;
      return;
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      this.latestAssistantMessage = event.message;
      this.scheduleFlush();
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      this.latestAssistantMessage = event.message;
      this.scheduleFlush();
      return;
    }

    if (
      event.type === "tool_execution_end" ||
      event.type === "turn_end" ||
      (event.type === "message_end" && event.message.role === "toolResult")
    ) {
      this.scheduleFlush();
    }
  }

  async finalize(result: GatewayMessageResult): Promise<void> {
    let status: ConvexRunStatus = result.ok
      ? "completed"
      : result.error?.includes("aborted")
        ? "interrupted"
        : "failed";
    let errorMessage = result.error;

    try {
      await this.finalFlush();
    } catch (error) {
      status = "failed";
      errorMessage = normalizeErrorMessage(error);
    }

    const endpoint =
      status === "completed"
        ? "/api/chat/complete-run"
        : status === "interrupted"
          ? "/api/chat/interrupt-run"
          : "/api/chat/fail-run";

    await this.callConvexHttpAction(endpoint, {
      runId: this.durableRun.runId,
      ...(status === "failed" && errorMessage ? { error: errorMessage } : {}),
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = globalThis.setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    this.throwIfFlushFailed();
    if (this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const items = this.buildItems();
    if (items.length === 0) {
      return;
    }

    const flushPromise = this.flushChain.then(async () => {
      this.throwIfFlushFailed();
      await this.callConvexHttpAction("/api/chat/run-messages", {
        runId: this.durableRun.runId,
        userId: this.durableRun.userId,
        agentId: this.durableRun.agentId,
        threadId: this.durableRun.threadId,
        sessionKey: this.durableRun.sessionKey,
        items,
      });
    });
    this.flushChain = flushPromise.catch(() => undefined);

    try {
      await flushPromise;
    } catch (error) {
      throw this.markFlushFailed(error);
    }
  }

  private async finalFlush(): Promise<void> {
    await this.flush();
    await this.flushChain;
    this.throwIfFlushFailed();
  }

  private buildItems(): PersistHistoryItem[] {
    const items: PersistHistoryItem[] = [];

    const assistantParts =
      this.latestAssistantMessage?.role === "assistant"
        ? messageContentToHistoryParts(this.latestAssistantMessage)
        : [];

    for (const toolResult of this.knownToolResults.values()) {
      assistantParts.push({
        type: "tool-invocation",
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        args: undefined,
        state: toolResult.isError ? "error" : "result",
        result: toolResult.result,
      });
    }

    const firstToolResult = this.knownToolResults.values().next().value;

    if (
      this.latestAssistantMessage?.role === "assistant" ||
      assistantParts.length > 0
    ) {
      items.push({
        role: "assistant",
        text:
          this.latestAssistantMessage?.role === "assistant"
            ? extractMessageText(this.latestAssistantMessage) || undefined
            : undefined,
        partsJson: JSON.stringify(assistantParts),
        timestamp:
          this.latestAssistantMessage?.timestamp ??
          firstToolResult?.timestamp ??
          Date.now(),
        idempotencyKey: this.assistantMessageId,
      });
    }

    return items;
  }

  private async callConvexHttpAction(
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(`${this.convexSiteUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.convexSecret}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Convex HTTP action failed for ${path}: ${response.status} ${text}`,
      );
    }
  }

  private throwIfFlushFailed(): void {
    if (this.flushFailure) {
      throw this.flushFailure;
    }
  }

  private markFlushFailed(error: unknown): Error {
    if (this.flushFailure) {
      return this.flushFailure;
    }
    const normalizedError =
      error instanceof Error ? error : new Error(normalizeErrorMessage(error));
    this.flushFailure = normalizedError;
    return normalizedError;
  }
}
