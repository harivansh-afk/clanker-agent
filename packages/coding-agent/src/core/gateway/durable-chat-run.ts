import type { AgentMessage } from "@mariozechner/companion-agent-core";
import type { AgentSessionEvent } from "../agent-session.js";
import { extractMessageText } from "./helpers.js";
import { messageContentToHistoryParts } from "./session-state.js";
import type { GatewayTransientToolResult } from "./session-state.js";
import type {
  GatewayMessageResult,
  GatewayMessageRequest,
  HistoryPart,
} from "./types.js";

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

type DurableChatRunEventBody =
  | {
      items: PersistHistoryItem[];
      final?: {
        status: ConvexRunStatus;
        error?: string;
      };
    }
  | {
      items?: PersistHistoryItem[];
      final: {
        status: ConvexRunStatus;
        error?: string;
      };
    };

function buildAuthHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export class DurableChatRunReporter {
  private readonly assistantMessageId: string;
  private latestAssistantMessage: AgentMessage | null = null;
  private accumulatedReasoningParts: Array<HistoryPart> = [];
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
    if (
      durableRun.callbackUrl.trim().length === 0 ||
      durableRun.callbackToken.trim().length === 0
    ) {
      throw new Error(
        "Durable chat run reporting requires callbackUrl and callbackToken",
      );
    }
    this.assistantMessageId = `run:${this.durableRun.runId}:assistant`;
  }

  handleSessionEvent(
    event: AgentSessionEvent,
    pendingToolResults: GatewayTransientToolResult[],
  ): void {
    for (const toolResult of pendingToolResults) {
      this.knownToolResults.set(toolResult.toolCallId, toolResult);
    }

    if (event.type === "message_start" && event.message.role === "assistant") {
      if (this.latestAssistantMessage?.role === "assistant") {
        const previousParts = messageContentToHistoryParts(
          this.latestAssistantMessage,
        );
        for (const part of previousParts) {
          if (part.type === "reasoning") {
            this.accumulatedReasoningParts.push(part);
          }
        }
      }
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
    await this.postEvent({
      final: {
        status,
        ...(status === "failed" && errorMessage ? { error: errorMessage } : {}),
      },
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
      await this.postEvent({
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
    const currentParts =
      this.latestAssistantMessage?.role === "assistant"
        ? messageContentToHistoryParts(this.latestAssistantMessage)
        : [];

    const currentReasoningTexts = new Set(
      currentParts
        .filter(
          (p): p is HistoryPart & { type: "reasoning" } =>
            p.type === "reasoning",
        )
        .map((p) => p.text),
    );

    const deduplicatedPrior = this.accumulatedReasoningParts.filter(
      (p) => p.type === "reasoning" && !currentReasoningTexts.has(p.text),
    );

    const assistantParts = [...deduplicatedPrior, ...currentParts];

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
      return [
        {
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
        },
      ];
    }

    return [];
  }

  private async postEvent(body: DurableChatRunEventBody): Promise<void> {
    const response = await fetch(this.durableRun.callbackUrl, {
      method: "POST",
      headers: buildAuthHeaders(this.durableRun.callbackToken),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Chat run relay failed: ${response.status} ${text}`.trim(),
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
