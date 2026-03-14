import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import type { AgentMessage } from "@mariozechner/companion-agent-core";
import type { AgentSession, AgentSessionEvent } from "../agent-session.js";
import type { Settings } from "../settings-manager.js";
import { DurableChatRunReporter } from "./durable-chat-run.js";
import { extractMessageText, getLastAssistantText } from "./helpers.js";
import {
  type GatewayEvent,
  HttpError,
  type ManagedGatewaySession,
} from "./internal-types.js";
import { sanitizeSessionKey } from "./session-manager.js";
import type {
  ChannelStatus,
  GatewayConfig,
  GatewayMessageRequest,
  GatewayMessageResult,
  GatewayRuntimeOptions,
  GatewaySessionFactory,
  GatewaySessionState,
  GatewaySessionSnapshot,
  HistoryMessage,
  ModelInfo,
} from "./types.js";
import {
  createGatewayStructuredPartListener,
  createVercelStreamListener,
  errorVercelStream,
  extractUserText,
  finishVercelStream,
} from "./vercel-ai-stream.js";
import {
  buildGatewaySessionStateMessages,
  messageContentToHistoryParts,
} from "./session-state.js";
import { findMostRecentSession } from "../session-manager.js";
export {
  createGatewaySessionManager,
  sanitizeSessionKey,
} from "./session-manager.js";
export type {
  ChannelStatus,
  GatewayConfig,
  GatewayMessageRequest,
  GatewayMessageResult,
  GatewayRuntimeOptions,
  GatewaySessionFactory,
  GatewaySessionState,
  GatewaySessionSnapshot,
  HistoryMessage,
  ModelInfo,
} from "./types.js";
export type { HistoryPart } from "./types.js";

let activeGatewayRuntime: GatewayRuntime | null = null;
const SSE_HEARTBEAT_MS = 15_000;

type JsonRecord = Record<string, unknown>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

type CompanionChannelsSettings = JsonRecord & {
  adapters?: Record<string, JsonRecord>;
  bridge?: JsonRecord;
  slack?: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecords(base: JsonRecord, overrides: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    if (isRecord(existing) && isRecord(value)) {
      merged[key] = mergeRecords(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function startSseHeartbeat(response: ServerResponse): () => void {
  const timer = setInterval(() => {
    if (response.writableEnded) {
      clearInterval(timer);
      return;
    }
    response.write(":\n\n");
  }, SSE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readDurableRun(
  value: unknown,
): GatewayMessageRequest["durableRun"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const runId = readString(value.runId);
  const callbackUrl = readString(value.callbackUrl);
  const callbackToken = readString(value.callbackToken);

  if (!runId || !callbackUrl || !callbackToken) {
    return undefined;
  }

  return {
    runId,
    callbackUrl,
    callbackToken,
  };
}

export function setActiveGatewayRuntime(runtime: GatewayRuntime | null): void {
  activeGatewayRuntime = runtime;
}

export function getActiveGatewayRuntime(): GatewayRuntime | null {
  return activeGatewayRuntime;
}

export class GatewayRuntime {
  private readonly config: GatewayConfig;
  private readonly primarySessionKey: string;
  private readonly primarySession: AgentSession;
  private readonly createSession: GatewaySessionFactory;
  private readonly log: (message: string) => void;
  private readonly sessions = new Map<string, ManagedGatewaySession>();
  private readonly sessionDirRoot: string;
  private server: Server | null = null;
  private idleSweepTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private logBuffer: string[] = [];
  private readonly maxLogBuffer = 1000;

  constructor(options: GatewayRuntimeOptions) {
    this.config = options.config;
    this.primarySessionKey = options.primarySessionKey;
    this.primarySession = options.primarySession;
    this.createSession = options.createSession;
    const originalLog = options.log;
    this.log = (msg: string) => {
      this.logBuffer.push(msg);
      if (this.logBuffer.length > this.maxLogBuffer) {
        this.logBuffer = this.logBuffer.slice(-this.maxLogBuffer);
      }
      originalLog?.(msg);
    };
    this.sessionDirRoot = join(
      options.primarySession.sessionManager.getSessionDir(),
      "..",
      "gateway-sessions",
    );
  }

  async start(): Promise<void> {
    if (this.server) return;

    await this.ensureSession(this.primarySessionKey, this.primarySession);
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        this.log(
          `[http] <-- ${request.method ?? "GET"} ${request.url ?? "/"} ${statusCode} error: ${message}`,
        );
        if (!response.writableEnded) {
          this.writeJson(response, statusCode, { error: message });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.bind, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    this.idleSweepTimer = setInterval(() => {
      void this.evictIdleSessions();
    }, 60_000);
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }
    for (const [sessionKey, managedSession] of this.sessions) {
      managedSession.unsubscribe();
      if (sessionKey !== this.primarySessionKey) {
        managedSession.session.dispose();
      }
    }
    this.sessions.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  getAddress(): { bind: string; port: number } {
    return { bind: this.config.bind, port: this.config.port };
  }

  async enqueueMessage(
    request: GatewayMessageRequest,
  ): Promise<GatewayMessageResult> {
    return this.enqueueManagedMessage({ request });
  }

  private async queueManagedMessage(queuedMessage: {
    request: GatewayMessageRequest;
    onStart?: () => void;
    onFinish?: () => void;
  }): Promise<
    | { accepted: false; errorResult: GatewayMessageResult }
    | {
        accepted: true;
        managedSession: ManagedGatewaySession;
        completion: Promise<GatewayMessageResult>;
      }
  > {
    const managedSession = await this.ensureSession(
      queuedMessage.request.sessionKey,
    );
    if (managedSession.queue.length >= this.config.session.maxQueuePerSession) {
      this.log(
        `[queue] session=${queuedMessage.request.sessionKey} queue full (${this.config.session.maxQueuePerSession})`,
      );
      return {
        accepted: false,
        errorResult: {
          ok: false,
          response: "",
          error: `Queue full (${this.config.session.maxQueuePerSession} pending).`,
          sessionKey: queuedMessage.request.sessionKey,
        },
      };
    }

    const completion = new Promise<GatewayMessageResult>((resolve) => {
      managedSession.queue.push({ ...queuedMessage, resolve });
    });
    this.logSession(
      managedSession,
      `queued source=${queuedMessage.request.source ?? "extension"} depth=${managedSession.queue.length}`,
    );
    this.emitState(managedSession);
    void this.processNext(managedSession);

    return { accepted: true, managedSession, completion };
  }

  private async enqueueManagedMessage(queuedMessage: {
    request: GatewayMessageRequest;
    onStart?: () => void;
    onFinish?: () => void;
  }): Promise<GatewayMessageResult> {
    const queued = await this.queueManagedMessage(queuedMessage);
    if (!queued.accepted) {
      return queued.errorResult;
    }
    return queued.completion;
  }

  async addSubscriber(
    sessionKey: string,
    listener: (event: GatewayEvent) => void,
  ): Promise<() => void> {
    const managedSession = await this.ensureSession(sessionKey);
    managedSession.listeners.add(listener);
    listener({
      type: "hello",
      sessionKey,
      snapshot: this.createSnapshot(managedSession),
    });
    return () => {
      managedSession.listeners.delete(listener);
    };
  }

  abortSession(sessionKey: string): boolean {
    const managedSession = this.sessions.get(sessionKey);
    if (!managedSession) {
      return false;
    }

    const hadQueuedMessages = managedSession.queue.length > 0;
    if (hadQueuedMessages) {
      this.rejectQueuedMessages(managedSession, "Session aborted");
      this.emitState(managedSession);
    }

    if (!managedSession.processing) {
      return hadQueuedMessages;
    }

    void managedSession.session.abort().catch((error) => {
      this.emit(managedSession, {
        type: "error",
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  clearQueue(sessionKey: string): void {
    const managedSession = this.sessions.get(sessionKey);
    if (!managedSession) return;
    managedSession.queue.length = 0;
    this.emitState(managedSession);
  }

  async resetSession(sessionKey: string): Promise<void> {
    const managedSession = this.sessions.get(sessionKey);
    if (!managedSession) return;

    if (managedSession.processing) {
      await managedSession.session.abort();
    }

    if (sessionKey === this.primarySessionKey) {
      this.rejectQueuedMessages(managedSession, "Session reset");
      await managedSession.session.newSession();
      managedSession.processing = false;
      managedSession.activeAssistantMessage = null;
      managedSession.pendingToolResults = [];
      managedSession.lastActiveAt = Date.now();
      this.emitState(managedSession);
      return;
    }

    this.rejectQueuedMessages(managedSession, "Session reset");
    managedSession.unsubscribe();
    managedSession.session.dispose();
    this.sessions.delete(sessionKey);
  }

  listSessions(): GatewaySessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) =>
      this.createSnapshot(session),
    );
  }

  getSession(sessionKey: string): GatewaySessionSnapshot | undefined {
    const session = this.sessions.get(sessionKey);
    return session ? this.createSnapshot(session) : undefined;
  }

  private summarizeText(text: string, maxLength = 96): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLength) {
      return singleLine;
    }
    return `${singleLine.slice(0, maxLength)}...`;
  }

  private logSession(
    managedSession: ManagedGatewaySession,
    message: string,
  ): void {
    this.log(`[session] session=${managedSession.sessionKey} ${message}`);
  }

  private async getOrLoadExistingSession(
    sessionKey: string,
  ): Promise<ManagedGatewaySession | null> {
    const found = this.sessions.get(sessionKey);
    if (found) {
      found.lastActiveAt = Date.now();
      return found;
    }

    if (!findMostRecentSession(this.getGatewaySessionDir(sessionKey))) {
      return null;
    }

    return this.ensureSession(sessionKey);
  }

  private async requireExistingSession(
    sessionKey: string,
  ): Promise<ManagedGatewaySession> {
    const managedSession = await this.getOrLoadExistingSession(sessionKey);
    if (!managedSession) {
      throw new HttpError(404, `Session not found: ${sessionKey}`);
    }
    return managedSession;
  }

  private async ensureSession(
    sessionKey: string,
    existingSession?: AgentSession,
  ): Promise<ManagedGatewaySession> {
    const found = this.sessions.get(sessionKey);
    if (found) {
      found.lastActiveAt = Date.now();
      return found;
    }

    const session = existingSession ?? (await this.createSession(sessionKey));
    const managedSession: ManagedGatewaySession = {
      sessionKey,
      session,
      queue: [],
      processing: false,
      activeDurableRun: null,
      activeAssistantMessage: null,
      pendingToolResults: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      listeners: new Set(),
      unsubscribe: () => {},
    };
    managedSession.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(managedSession, event);
    });
    this.sessions.set(sessionKey, managedSession);
    this.emitState(managedSession);
    return managedSession;
  }

  private async resolveMemorySession(
    sessionKey: string | null | undefined,
  ): Promise<AgentSession> {
    if (!sessionKey || sessionKey === this.primarySessionKey) {
      return this.primarySession;
    }
    const managedSession = await this.ensureSession(sessionKey);
    return managedSession.session;
  }

  private async processNext(
    managedSession: ManagedGatewaySession,
  ): Promise<void> {
    if (managedSession.processing || managedSession.queue.length === 0) {
      return;
    }

    const queued = managedSession.queue.shift();
    if (!queued) return;

    managedSession.processing = true;
    managedSession.lastActiveAt = Date.now();
    this.logSession(
      managedSession,
      `processing source=${queued.request.source ?? "extension"} remaining=${managedSession.queue.length}`,
    );
    this.emitState(managedSession);

    let result: GatewayMessageResult = {
      ok: false,
      response: "",
      error: "Unknown error",
      sessionKey: managedSession.sessionKey,
    };
    let durableRunReporter: DurableChatRunReporter | null = null;

    try {
      queued.onStart?.();
      if (queued.request.durableRun) {
        durableRunReporter = new DurableChatRunReporter(
          queued.request.durableRun,
        );
        managedSession.activeDurableRun = durableRunReporter;
      }
      await managedSession.session.prompt(queued.request.text, {
        images: queued.request.images,
        source: queued.request.source ?? "extension",
      });
      const response = getLastAssistantText(managedSession.session);
      result = {
        ok: true,
        response,
        sessionKey: managedSession.sessionKey,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(
        `[prompt] session=${managedSession.sessionKey} error: ${message}`,
      );
      if (message.includes("aborted")) {
        this.emit(managedSession, {
          type: "aborted",
          sessionKey: managedSession.sessionKey,
        });
      } else {
        this.emit(managedSession, {
          type: "error",
          sessionKey: managedSession.sessionKey,
          error: message,
        });
      }
      result = {
        ok: false,
        response: "",
        error: message,
        sessionKey: managedSession.sessionKey,
      };
    } finally {
      queued.onFinish?.();
      if (durableRunReporter) {
        try {
          await durableRunReporter.finalize(result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.log(
            `[chat-run] session=${managedSession.sessionKey} finalize error: ${message}`,
          );
          this.emit(managedSession, {
            type: "error",
            sessionKey: managedSession.sessionKey,
            error: message,
          });
          result = {
            ok: false,
            response: result.response,
            error: message,
            sessionKey: managedSession.sessionKey,
          };
        }
      }
      queued.resolve(result);
      managedSession.processing = false;
      managedSession.activeDurableRun = null;
      managedSession.activeAssistantMessage = null;
      managedSession.pendingToolResults = [];
      managedSession.lastActiveAt = Date.now();
      this.emitState(managedSession);
      if (managedSession.queue.length > 0) {
        void this.processNext(managedSession);
      }
    }
  }

  private rejectQueuedMessages(
    managedSession: ManagedGatewaySession,
    error: string,
  ): void {
    const queuedMessages = managedSession.queue.splice(0);
    for (const queuedMessage of queuedMessages) {
      queuedMessage.resolve({
        ok: false,
        response: "",
        error,
        sessionKey: managedSession.sessionKey,
      });
    }
  }

  private handleSessionEvent(
    managedSession: ManagedGatewaySession,
    event: AgentSessionEvent,
  ): void {
    const forwardToDurableRun = () => {
      managedSession.activeDurableRun?.handleSessionEvent(
        event,
        managedSession.pendingToolResults,
      );
    };

    switch (event.type) {
      case "turn_start":
        managedSession.lastActiveAt = Date.now();
        this.logSession(managedSession, "turn_start");
        this.emit(managedSession, {
          type: "turn_start",
          sessionKey: managedSession.sessionKey,
        });
        forwardToDurableRun();
        return;
      case "turn_end":
        managedSession.lastActiveAt = Date.now();
        this.logSession(managedSession, "turn_end");
        this.emit(managedSession, {
          type: "turn_end",
          sessionKey: managedSession.sessionKey,
        });
        forwardToDurableRun();
        return;
      case "message_start":
        managedSession.lastActiveAt = Date.now();
        if (event.message.role === "assistant") {
          managedSession.activeAssistantMessage = event.message;
        }
        this.emit(managedSession, {
          type: "message_start",
          sessionKey: managedSession.sessionKey,
          role: event.message.role,
        });
        forwardToDurableRun();
        return;
      case "message_update":
        managedSession.lastActiveAt = Date.now();
        if (event.message.role === "assistant") {
          managedSession.activeAssistantMessage = event.message;
        }
        switch (event.assistantMessageEvent.type) {
          case "text_delta":
            this.emit(managedSession, {
              type: "token",
              sessionKey: managedSession.sessionKey,
              delta: event.assistantMessageEvent.delta,
              contentIndex: event.assistantMessageEvent.contentIndex,
            });
            forwardToDurableRun();
            return;
          case "thinking_delta":
            this.emit(managedSession, {
              type: "thinking",
              sessionKey: managedSession.sessionKey,
              delta: event.assistantMessageEvent.delta,
              contentIndex: event.assistantMessageEvent.contentIndex,
            });
            forwardToDurableRun();
            return;
        }
        forwardToDurableRun();
        return;
      case "message_end":
        managedSession.lastActiveAt = Date.now();
        if (event.message.role === "assistant") {
          managedSession.activeAssistantMessage = null;
          this.logSession(
            managedSession,
            `assistant_complete text="${this.summarizeText(extractMessageText(event.message))}"`,
          );
          this.emit(managedSession, {
            type: "message_complete",
            sessionKey: managedSession.sessionKey,
            text: extractMessageText(event.message),
          });
          this.emitStructuredParts(managedSession, event.message);
          forwardToDurableRun();
          return;
        }
        if (event.message.role === "toolResult") {
          const toolCallId =
            typeof (event.message as { toolCallId?: unknown }).toolCallId ===
            "string"
              ? ((event.message as { toolCallId: string }).toolCallId ?? "")
              : "";
          if (toolCallId) {
            managedSession.pendingToolResults =
              managedSession.pendingToolResults.filter(
                (entry) => entry.toolCallId !== toolCallId,
              );
          }
        }
        forwardToDurableRun();
        return;
      case "tool_execution_start":
        managedSession.lastActiveAt = Date.now();
        this.logSession(
          managedSession,
          `tool_start name=${event.toolName} call=${event.toolCallId}`,
        );
        this.emit(managedSession, {
          type: "tool_start",
          sessionKey: managedSession.sessionKey,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        forwardToDurableRun();
        return;
      case "tool_execution_update":
        managedSession.lastActiveAt = Date.now();
        this.emit(managedSession, {
          type: "tool_update",
          sessionKey: managedSession.sessionKey,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult,
        });
        forwardToDurableRun();
        return;
      case "tool_execution_end":
        managedSession.lastActiveAt = Date.now();
        managedSession.pendingToolResults = [
          ...managedSession.pendingToolResults.filter(
            (entry) => entry.toolCallId !== event.toolCallId,
          ),
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            timestamp: Date.now(),
          },
        ];
        this.logSession(
          managedSession,
          `tool_complete name=${event.toolName} call=${event.toolCallId} ok=${!event.isError}`,
        );
        this.emit(managedSession, {
          type: "tool_complete",
          sessionKey: managedSession.sessionKey,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        forwardToDurableRun();
        return;
    }
  }

  private emit(
    managedSession: ManagedGatewaySession,
    event: GatewayEvent,
  ): void {
    for (const listener of managedSession.listeners) {
      listener(event);
    }
  }

  private emitState(managedSession: ManagedGatewaySession): void {
    this.emit(managedSession, {
      type: "session_state",
      sessionKey: managedSession.sessionKey,
      snapshot: this.createSnapshot(managedSession),
    });
  }

  private emitStructuredParts(
    managedSession: ManagedGatewaySession,
    message: AssistantAgentMessage,
  ): void {
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const part of content) {
      const rawPart: unknown = part;
      if (!isRecord(rawPart)) continue;
      const p = rawPart;

      if (p.type === "teamActivity") {
        const teamId = typeof p.teamId === "string" ? p.teamId : "";
        const status = typeof p.status === "string" ? p.status : "running";
        if (!teamId) continue;
        const rawMembers = Array.isArray(p.members) ? p.members : [];
        const members = rawMembers
          .filter(
            (m): m is Record<string, unknown> =>
              typeof m === "object" && m !== null,
          )
          .map((m) => ({
            id: typeof m.id === "string" ? m.id : "",
            name: typeof m.name === "string" ? m.name : "Teammate",
            ...(typeof m.role === "string" ? { role: m.role } : {}),
            status: typeof m.status === "string" ? m.status : "running",
            ...(typeof m.message === "string" ? { message: m.message } : {}),
          }))
          .filter((m) => m.id.length > 0);
        this.emit(managedSession, {
          type: "structured_part",
          sessionKey: managedSession.sessionKey,
          partType: "teamActivity",
          payload: { teamId, status, members },
        });
        continue;
      }

      if (p.type === "image") {
        const url = typeof p.url === "string" ? p.url : "";
        if (!url) continue;
        this.emit(managedSession, {
          type: "structured_part",
          sessionKey: managedSession.sessionKey,
          partType: "media",
          payload: {
            url,
            ...(typeof p.mimeType === "string" ? { mimeType: p.mimeType } : {}),
          },
        });
        continue;
      }

      if (p.type === "error") {
        const errorMessage = typeof p.message === "string" ? p.message : "";
        if (!errorMessage) continue;
        this.emit(managedSession, {
          type: "structured_part",
          sessionKey: managedSession.sessionKey,
          partType: "error",
          payload: {
            code: typeof p.code === "string" ? p.code : "unknown",
            message: errorMessage,
          },
        });
      }
    }
  }

  private createSessionState(
    managedSession: ManagedGatewaySession,
  ): GatewaySessionState {
    return {
      session: this.createSnapshot(managedSession),
      messages: buildGatewaySessionStateMessages({
        sessionKey: managedSession.sessionKey,
        rawMessages: managedSession.session.messages,
        activeAssistantMessage: managedSession.activeAssistantMessage,
        pendingToolResults: managedSession.pendingToolResults,
      }),
    };
  }

  private createSnapshot(
    managedSession: ManagedGatewaySession,
  ): GatewaySessionSnapshot {
    const messages = managedSession.session.messages;
    const currentModel = managedSession.session.model;
    const name = managedSession.session.sessionName?.trim() || undefined;
    let lastMessagePreview: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" || msg.role === "assistant") {
        const content = (msg as { content: unknown }).content;
        if (typeof content === "string" && content.length > 0) {
          lastMessagePreview = content.slice(0, 120);
          break;
        }
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              (part as { type: string }).type === "text"
            ) {
              const text = (part as { text: string }).text;
              if (text.length > 0) {
                lastMessagePreview = text.slice(0, 120);
                break;
              }
            }
          }
          if (lastMessagePreview) break;
        }
      }
    }
    return {
      sessionKey: managedSession.sessionKey,
      sessionId: managedSession.session.sessionId,
      messageCount: messages.length,
      queueDepth: managedSession.queue.length,
      processing: managedSession.processing,
      lastActiveAt: managedSession.lastActiveAt,
      createdAt: managedSession.createdAt,
      updatedAt: managedSession.lastActiveAt,
      name,
      lastMessagePreview,
      modelProvider: currentModel?.provider,
      modelId: currentModel?.id,
    };
  }

  private async evictIdleSessions(): Promise<void> {
    const cutoff = Date.now() - this.config.session.idleMinutes * 60_000;
    for (const [sessionKey, managedSession] of this.sessions) {
      if (sessionKey === this.primarySessionKey) {
        continue;
      }
      if (managedSession.processing || managedSession.queue.length > 0) {
        continue;
      }
      if (managedSession.lastActiveAt > cutoff) {
        continue;
      }
      if (managedSession.listeners.size > 0) {
        continue;
      }
      managedSession.unsubscribe();
      managedSession.session.dispose();
      this.sessions.delete(sessionKey);
      this.log(`evicted idle session ${sessionKey}`);
    }
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }

    const method = request.method ?? "GET";

    if (method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.config.bind}:${this.config.port}`}`,
    );
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      this.writeJson(response, 200, { ok: true, ready: this.ready });
      return;
    }

    if (method === "GET" && path === "/ready") {
      this.requireAuth(request, response);
      if (response.writableEnded) return;
      this.writeJson(response, 200, {
        ok: true,
        ready: this.ready,
        sessions: this.sessions.size,
      });
      return;
    }

    if (
      this.config.webhook.enabled &&
      method === "POST" &&
      path.startsWith(this.config.webhook.basePath)
    ) {
      await this.handleWebhookRequest(path, request, response);
      return;
    }

    this.requireAuth(request, response);
    if (response.writableEnded) return;

    if (method === "GET" && path === "/sessions") {
      this.writeJson(response, 200, { sessions: this.listSessions() });
      return;
    }

    if (method === "GET" && path === "/models") {
      const models = await this.handleGetModels();
      this.writeJson(response, 200, models);
      return;
    }

    if (method === "GET" && path === "/config") {
      const config = this.getPublicConfig();
      this.writeJson(response, 200, config);
      return;
    }

    if (method === "PATCH" && path === "/config") {
      const body = await this.readJsonBody(request);
      await this.handlePatchConfig(body);
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/channels/status") {
      const status = this.handleGetChannelsStatus();
      this.writeJson(response, 200, { channels: status });
      return;
    }

    if (method === "GET" && path === "/logs") {
      const logs = this.handleGetLogs();
      this.writeJson(response, 200, { logs });
      return;
    }

    if (method === "GET" && path === "/memory/status") {
      const sessionKey = url.searchParams.get("sessionKey");
      const memorySession = await this.resolveMemorySession(sessionKey);
      const memory = await memorySession.getMemoryStatus();
      this.writeJson(response, 200, { memory });
      return;
    }

    if (method === "GET" && path === "/memory/core") {
      const sessionKey = url.searchParams.get("sessionKey");
      const memorySession = await this.resolveMemorySession(sessionKey);
      const memories = await memorySession.getCoreMemories();
      this.writeJson(response, 200, { memories });
      return;
    }

    if (method === "POST" && path === "/memory/search") {
      const body = await this.readJsonBody(request);
      const query = typeof body.query === "string" ? body.query : "";
      const limit =
        typeof body.limit === "number" && Number.isFinite(body.limit)
          ? Math.max(1, Math.floor(body.limit))
          : undefined;
      const sessionKey =
        typeof body.sessionKey === "string" ? body.sessionKey : undefined;
      const memorySession = await this.resolveMemorySession(sessionKey);
      const result = await memorySession.searchMemory(query, limit);
      this.writeJson(response, 200, result);
      return;
    }

    if (method === "POST" && path === "/memory/remember") {
      const body = await this.readJsonBody(request);
      const content = typeof body.content === "string" ? body.content : "";
      if (!content.trim()) {
        this.writeJson(response, 400, { error: "Missing memory content" });
        return;
      }
      const sessionKey =
        typeof body.sessionKey === "string" ? body.sessionKey : undefined;
      const memorySession = await this.resolveMemorySession(sessionKey);
      const memory = await memorySession.rememberMemory({
        bucket:
          body.bucket === "core" || body.bucket === "archival"
            ? body.bucket
            : undefined,
        kind:
          body.kind === "profile" ||
          body.kind === "preference" ||
          body.kind === "relationship" ||
          body.kind === "fact" ||
          body.kind === "secret"
            ? body.kind
            : undefined,
        key: typeof body.key === "string" ? body.key : undefined,
        content,
        source: "manual",
      });
      this.writeJson(response, 200, { ok: true, memory });
      return;
    }

    if (method === "POST" && path === "/memory/forget") {
      const body = await this.readJsonBody(request);
      const id =
        typeof body.id === "number" && Number.isFinite(body.id)
          ? Math.floor(body.id)
          : undefined;
      const key = typeof body.key === "string" ? body.key : undefined;
      if (id === undefined && !key) {
        this.writeJson(response, 400, {
          error: "Memory forget requires an id or key",
        });
        return;
      }
      const sessionKey =
        typeof body.sessionKey === "string" ? body.sessionKey : undefined;
      const memorySession = await this.resolveMemorySession(sessionKey);
      const result = await memorySession.forgetMemory({
        id,
        key,
      });
      this.writeJson(response, 200, result);
      return;
    }

    if (method === "POST" && path === "/memory/rebuild") {
      const body = await this.readJsonBody(request);
      const sessionKey =
        typeof body.sessionKey === "string" ? body.sessionKey : undefined;
      const memorySession = await this.resolveMemorySession(sessionKey);
      const result = await memorySession.rebuildMemory();
      this.writeJson(response, 200, result);
      return;
    }

    const sessionMatch = path.match(
      /^\/sessions\/([^/]+)(?:\/(enqueue|events|messages|abort|reset|chat|history|model|reload|state|steer))?$/,
    );
    if (!sessionMatch) {
      this.writeJson(response, 404, { error: "Not found" });
      return;
    }

    const sessionKey = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];

    if (!action && method === "GET") {
      const session = await this.ensureSession(sessionKey);
      this.writeJson(response, 200, { session: this.createSnapshot(session) });
      return;
    }

    if (!action && method === "PATCH") {
      const body = await this.readJsonBody(request);
      await this.handlePatchSession(sessionKey, body as { name?: string });
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (!action && method === "DELETE") {
      await this.handleDeleteSession(sessionKey);
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (action === "events" && method === "GET") {
      await this.handleSse(sessionKey, request, response);
      return;
    }

    if (action === "chat" && method === "POST") {
      await this.handleChat(sessionKey, request, response);
      return;
    }

    if (action === "enqueue" && method === "POST") {
      const body = await this.readJsonBody(request);
      const text = extractUserText(body);
      if (!text) {
        this.writeJson(response, 400, { error: "Missing user message text" });
        return;
      }
      const durableRun = readDurableRun(body.durableRun);
      const queued = await this.queueManagedMessage({
        request: {
          sessionKey,
          text,
          source: "extension",
          metadata: isRecord(body.metadata) ? body.metadata : undefined,
          durableRun,
        },
      });
      if (!queued.accepted) {
        this.writeJson(response, 409, queued.errorResult);
        return;
      }
      void queued.completion.catch(() => undefined);
      this.writeJson(response, 202, {
        ok: true,
        queued: true,
        sessionKey,
        ...(durableRun ? { runId: durableRun.runId } : {}),
      });
      return;
    }

    if (action === "messages" && method === "POST") {
      const body = await this.readJsonBody(request);
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        this.writeJson(response, 400, { error: "Missing text" });
        return;
      }
      const result = await this.enqueueMessage({
        sessionKey,
        text,
        source: "extension",
      });
      this.writeJson(response, result.ok ? 200 : 500, result);
      return;
    }

    if (action === "abort" && method === "POST") {
      await this.requireExistingSession(sessionKey);
      this.writeJson(response, 200, { ok: this.abortSession(sessionKey) });
      return;
    }

    if (action === "steer" && method === "POST") {
      const body = await this.readJsonBody(request);
      const text = extractUserText(body);
      if (!text) {
        this.writeJson(response, 400, { error: "Missing user message text" });
        return;
      }
      const result = await this.handleSteer(sessionKey, text);
      this.writeJson(response, 200, result);
      return;
    }

    if (action === "reset" && method === "POST") {
      await this.requireExistingSession(sessionKey);
      await this.resetSession(sessionKey);
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (action === "history" && method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const messages = await this.handleGetHistory(
        sessionKey,
        limitParam ? parseInt(limitParam, 10) : undefined,
      );
      this.writeJson(response, 200, { messages });
      return;
    }

    if (action === "state" && method === "GET") {
      const session = await this.requireExistingSession(sessionKey);
      this.writeJson(response, 200, this.createSessionState(session));
      return;
    }

    if (action === "model" && method === "POST") {
      const body = await this.readJsonBody(request);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      const result = await this.handleSetModel(sessionKey, provider, modelId);
      this.writeJson(response, 200, result);
      return;
    }

    if (action === "reload" && method === "POST") {
      await this.handleReloadSession(sessionKey);
      this.writeJson(response, 200, { ok: true });
      return;
    }

    this.writeJson(response, 405, { error: "Method not allowed" });
  }

  private async handleWebhookRequest(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const route =
      path.slice(this.config.webhook.basePath.length).replace(/^\/+/, "") ||
      "default";
    if (this.config.webhook.secret) {
      const presentedSecret = request.headers["x-companion-webhook-secret"];
      if (presentedSecret !== this.config.webhook.secret) {
        this.writeJson(response, 401, { error: "Invalid webhook secret" });
        return;
      }
    }

    const body = await this.readJsonBody(request);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      this.writeJson(response, 400, { error: "Missing text" });
      return;
    }

    const conversationId =
      typeof body.sessionKey === "string"
        ? body.sessionKey
        : `webhook:${route}:${typeof body.sender === "string" ? body.sender : "default"}`;
    const result = await this.enqueueMessage({
      sessionKey: conversationId,
      text,
      source: "extension",
      metadata:
        typeof body.metadata === "object" && body.metadata
          ? (body.metadata as Record<string, unknown>)
          : {},
    });
    this.writeJson(response, result.ok ? 200 : 500, result);
  }

  private async handleSse(
    sessionKey: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write("\n");
    const stopHeartbeat = startSseHeartbeat(response);

    const unsubscribe = await this.addSubscriber(sessionKey, (event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.on("close", () => {
      stopHeartbeat();
      unsubscribe();
    });
  }

  private async handleChat(
    sessionKey: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readJsonBody(request);
    const text = extractUserText(body);
    if (!text) {
      this.writeJson(response, 400, { error: "Missing user message text" });
      return;
    }

    const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    this.log(`[chat] session=${sessionKey} text="${preview}"`);

    // Set up SSE response headers
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    });
    response.write("\n");
    const stopHeartbeat = startSseHeartbeat(response);

    const listener = createVercelStreamListener(response);
    const structuredPartListener =
      createGatewayStructuredPartListener(response);
    let unsubscribe: (() => void) | undefined;
    let unsubscribeStructured: (() => void) | undefined;
    let streamingActive = false;

    const stopStreaming = () => {
      if (!streamingActive) return;
      streamingActive = false;
      unsubscribe?.();
      unsubscribe = undefined;
      unsubscribeStructured?.();
      unsubscribeStructured = undefined;
    };

    // Clean up on client disconnect
    let clientDisconnected = false;
    request.on("close", () => {
      clientDisconnected = true;
      stopHeartbeat();
      stopStreaming();
    });

    // Drive the session through the existing queue infrastructure
    try {
      const managedSession = await this.ensureSession(sessionKey);
      const result = await this.enqueueManagedMessage({
        request: {
          sessionKey,
          text,
          source: "extension",
        },
        onStart: () => {
          if (clientDisconnected || streamingActive) return;
          unsubscribe = managedSession.session.subscribe(listener);
          managedSession.listeners.add(structuredPartListener);
          unsubscribeStructured = () => {
            managedSession.listeners.delete(structuredPartListener);
          };
          streamingActive = true;
        },
        onFinish: () => {
          stopStreaming();
        },
      });
      if (!clientDisconnected) {
        stopStreaming();
        stopHeartbeat();
        if (result.ok) {
          this.log(`[chat] session=${sessionKey} completed ok`);
          finishVercelStream(response, "stop");
        } else {
          const isAbort = result.error?.includes("aborted");
          this.log(
            `[chat] session=${sessionKey} failed: ${result.error}${isAbort ? " (aborted)" : ""}`,
          );
          if (isAbort) {
            finishVercelStream(response, "error");
          } else {
            errorVercelStream(response, result.error ?? "Unknown error");
          }
        }
      } else {
        this.log(`[chat] session=${sessionKey} client disconnected`);
      }
    } catch (error) {
      if (!clientDisconnected) {
        stopStreaming();
        stopHeartbeat();
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[chat] session=${sessionKey} exception: ${message}`);
        errorVercelStream(response, message);
      }
    }
  }

  private async handleSteer(
    sessionKey: string,
    text: string,
  ): Promise<{ ok: true; mode: "steer" | "queued"; sessionKey: string }> {
    const managedSession = await this.requireExistingSession(sessionKey);
    const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;

    if (managedSession.processing) {
      this.logSession(managedSession, `steer text="${preview}"`);
      await managedSession.session.steer(text);
      return { ok: true, mode: "steer", sessionKey };
    }

    const queued = await this.queueManagedMessage({
      request: {
        sessionKey,
        text,
        source: "extension",
      },
    });
    if (!queued.accepted) {
      throw new HttpError(
        409,
        queued.errorResult.error ?? "Failed to queue message.",
      );
    }
    this.logSession(
      queued.managedSession,
      `steer-fallback queued text="${preview}"`,
    );
    void queued.completion.then((result) => {
      if (!result.ok) {
        this.log(
          `[steer] session=${sessionKey} queued fallback failed: ${result.error ?? "Unknown error"}`,
        );
      }
    });

    return { ok: true, mode: "queued", sessionKey };
  }

  private requireAuth(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (!this.config.bearerToken) {
      return;
    }
    const header = request.headers.authorization;
    if (header === `Bearer ${this.config.bearerToken}`) {
      return;
    }
    this.writeJson(response, 401, { error: "Unauthorized" });
  }

  private async readJsonBody(
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length === 0) {
      return {};
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  // ---------------------------------------------------------------------------
  // New handler methods added for companion-cloud web app integration
  // ---------------------------------------------------------------------------

  private async handleGetModels(): Promise<{
    models: ModelInfo[];
    current: { provider: string; modelId: string } | null;
  }> {
    const available = this.primarySession.modelRegistry.getAvailable();
    const models: ModelInfo[] = available.map((m) => ({
      provider: m.provider,
      modelId: m.id,
      displayName: m.name,
      capabilities: [
        ...(m.reasoning ? ["reasoning"] : []),
        ...(m.input.includes("image") ? ["vision"] : []),
      ],
    }));
    const currentModel = this.primarySession.model;
    const current = currentModel
      ? { provider: currentModel.provider, modelId: currentModel.id }
      : null;
    return { models, current };
  }

  private async handleSetModel(
    sessionKey: string,
    provider: string,
    modelId: string,
  ): Promise<{ ok: true; model: { provider: string; modelId: string } }> {
    const managed = await this.ensureSession(sessionKey);
    const found = managed.session.modelRegistry.find(provider, modelId);
    if (!found) {
      throw new HttpError(404, `Model not found: ${provider}/${modelId}`);
    }
    await managed.session.setModel(found);
    return { ok: true, model: { provider, modelId } };
  }

  private async handleGetHistory(
    sessionKey: string,
    limit?: number,
  ): Promise<HistoryMessage[]> {
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      throw new HttpError(400, "History limit must be a positive integer");
    }
    const managed = await this.requireExistingSession(sessionKey);
    const rawMessages = managed.session.messages;
    const messages: HistoryMessage[] = [];
    for (const [index, msg] of rawMessages.entries()) {
      if (
        msg.role !== "user" &&
        msg.role !== "assistant" &&
        msg.role !== "toolResult"
      ) {
        continue;
      }
      messages.push({
        id: `${msg.timestamp}-${msg.role}-${index}`,
        role: msg.role,
        parts: messageContentToHistoryParts(msg),
        timestamp: msg.timestamp,
      });
    }
    return limit ? messages.slice(-limit) : messages;
  }

  private async handlePatchSession(
    sessionKey: string,
    patch: { name?: string },
  ): Promise<void> {
    const managed = await this.requireExistingSession(sessionKey);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) {
        throw new HttpError(400, "Session name cannot be empty");
      }
      managed.session.sessionManager.appendSessionInfo(name);
      managed.lastActiveAt = Date.now();
      this.emitState(managed);
    }
  }

  private async handleDeleteSession(sessionKey: string): Promise<void> {
    if (sessionKey === this.primarySessionKey) {
      throw new HttpError(400, "Cannot delete primary session");
    }
    const managed = await this.requireExistingSession(sessionKey);
    if (managed) {
      if (managed.processing) {
        await managed.session.abort();
      }
      this.rejectQueuedMessages(managed, `Session deleted: ${sessionKey}`);
      managed.unsubscribe();
      managed.session.dispose();
      this.sessions.delete(sessionKey);
    }
    await rm(this.getGatewaySessionDir(sessionKey), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  private getPublicConfig(): Record<string, unknown> {
    const settings = this.primarySession.settingsManager.getGlobalSettings();
    const { gateway, ...rest } = settings as Record<string, unknown> & {
      gateway?: Record<string, unknown>;
    };
    const {
      bearerToken: _bearerToken,
      webhook,
      ...safeGatewayRest
    } = gateway ?? {};
    const { secret: _secret, ...safeWebhook } =
      webhook && typeof webhook === "object"
        ? (webhook as Record<string, unknown>)
        : {};
    return {
      ...rest,
      gateway: {
        ...safeGatewayRest,
        ...(webhook && typeof webhook === "object"
          ? { webhook: safeWebhook }
          : {}),
      },
    };
  }

  private async handlePatchConfig(
    patch: Record<string, unknown>,
  ): Promise<void> {
    // Apply overrides on top of current settings (in-memory only for daemon use)
    this.primarySession.settingsManager.applyOverrides(patch as Settings);
  }

  private getCompanionChannelsSettings(): CompanionChannelsSettings {
    const globalSettings =
      this.primarySession.settingsManager.getGlobalSettings();
    const projectSettings =
      this.primarySession.settingsManager.getProjectSettings();
    const mergedSettings = mergeRecords(
      isRecord(globalSettings) ? globalSettings : {},
      isRecord(projectSettings) ? projectSettings : {},
    );
    const piChannels = mergedSettings["companion-channels"];
    return isRecord(piChannels)
      ? (piChannels as CompanionChannelsSettings)
      : {};
  }

  private buildSlackChannelStatus(
    config: CompanionChannelsSettings,
    bridgeEnabled: boolean,
  ): ChannelStatus {
    const adapters = isRecord(config.adapters) ? config.adapters : {};
    const adapter = isRecord(adapters.slack) ? adapters.slack : undefined;
    const slackSettings = isRecord(config.slack) ? config.slack : undefined;
    const appToken = readString(slackSettings?.appToken);
    const botToken = readString(slackSettings?.botToken);

    const hasConfig =
      adapter !== undefined || appToken !== undefined || botToken !== undefined;
    const adapterType = readString(adapter?.type);

    let configured = false;
    let error: string | undefined;

    if (hasConfig) {
      if (!adapter) {
        error =
          'Slack requires `companion-channels.adapters.slack = { "type": "slack" }`.';
      } else if (adapterType !== "slack") {
        error = 'Slack adapter type must be "slack".';
      } else if (!appToken) {
        error = "Slack requires companion-channels.slack.appToken.";
      } else if (!botToken) {
        error = "Slack requires companion-channels.slack.botToken.";
      } else {
        configured = true;
      }
    }

    if (configured && !bridgeEnabled) {
      error =
        "Slack is configured, but companion-channels.bridge.enabled is false, so messages will not reach the agent.";
    }

    return {
      id: "slack",
      name: "Slack",
      configured,
      running: configured,
      connected: configured && bridgeEnabled,
      error,
    };
  }

  private buildTelegramChannelStatus(
    config: CompanionChannelsSettings,
    bridgeEnabled: boolean,
  ): ChannelStatus {
    const adapters = isRecord(config.adapters) ? config.adapters : {};
    const adapter = isRecord(adapters.telegram) ? adapters.telegram : undefined;
    const botToken = readString(adapter?.botToken);
    const pollingEnabled = adapter?.polling === true;

    const hasConfig = adapter !== undefined || botToken !== undefined;
    const adapterType = readString(adapter?.type);

    let configured = false;
    let error: string | undefined;

    if (hasConfig) {
      if (!adapter) {
        error =
          'Telegram requires `companion-channels.adapters.telegram = { "type": "telegram", "botToken": "...", "polling": true }`.';
      } else if (adapterType !== "telegram") {
        error = 'Telegram adapter type must be "telegram".';
      } else if (!botToken) {
        error =
          "Telegram requires companion-channels.adapters.telegram.botToken.";
      } else if (!pollingEnabled) {
        error =
          "Telegram requires companion-channels.adapters.telegram.polling = true.";
      } else {
        configured = true;
      }
    }

    if (configured && !bridgeEnabled) {
      error =
        "Telegram is configured, but companion-channels.bridge.enabled is false, so messages will not reach the agent.";
    }

    return {
      id: "telegram",
      name: "Telegram",
      configured,
      running: configured,
      connected: configured && bridgeEnabled,
      error,
    };
  }

  private handleGetChannelsStatus(): ChannelStatus[] {
    const config = this.getCompanionChannelsSettings();
    const bridgeEnabled = config.bridge?.enabled === true;

    return [
      this.buildSlackChannelStatus(config, bridgeEnabled),
      this.buildTelegramChannelStatus(config, bridgeEnabled),
    ];
  }

  private handleGetLogs(): string[] {
    return this.logBuffer.slice(-200);
  }

  private async handleReloadSession(sessionKey: string): Promise<void> {
    const managed = await this.requireExistingSession(sessionKey);
    // Rebuild the full session runtime so auth.json, models.json, settings,
    // and extension-backed resources all pick up on-disk changes.
    await managed.session.reload();
    managed.lastActiveAt = Date.now();
    this.emitState(managed);
  }

  getGatewaySessionDir(sessionKey: string): string {
    return join(this.sessionDirRoot, sanitizeSessionKey(sessionKey));
  }
}
