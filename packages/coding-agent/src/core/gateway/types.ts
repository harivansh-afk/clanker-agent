import type { ImageContent } from "@mariozechner/companion-ai";
import type { AgentSession } from "../agent-session.js";

export interface GatewayConfig {
  bind: string;
  port: number;
  bearerToken?: string;
  session: {
    idleMinutes: number;
    maxQueuePerSession: number;
  };
  webhook: {
    enabled: boolean;
    basePath: string;
    secret?: string;
  };
}

export type GatewaySessionFactory = (
  sessionKey: string,
) => Promise<AgentSession>;

export interface GatewayMessageRequest {
  sessionKey: string;
  text: string;
  source?: "interactive" | "rpc" | "extension";
  images?: ImageContent[];
  metadata?: Record<string, unknown>;
}

export interface GatewayMessageResult {
  ok: boolean;
  response: string;
  error?: string;
  sessionKey: string;
}

export interface GatewaySessionSnapshot {
  sessionKey: string;
  sessionId: string;
  messageCount: number;
  queueDepth: number;
  processing: boolean;
  lastActiveAt: number;
  createdAt: number;
  name?: string;
  lastMessagePreview?: string;
  updatedAt: number;
}

export interface GatewaySessionState {
  session: GatewaySessionSnapshot;
  messages: HistoryMessage[];
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  capabilities?: string[];
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  parts: HistoryPart[];
  timestamp: number;
}

export type HistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-invocation";
      toolCallId: string;
      toolName: string;
      args: unknown;
      state: string;
      result?: unknown;
    }
  | {
      type: "teamActivity";
      teamId: string;
      status: string;
      members: Array<{ id: string; name: string; role?: string; status: string; message?: string }>;
    }
  | { type: "media"; url: string; mimeType?: string }
  | { type: "error"; code: string; message: string };

export interface ChannelStatus {
  id: string;
  name: string;
  connected: boolean;
  running?: boolean;
  configured?: boolean;
  error?: string;
}

export interface GatewayRuntimeOptions {
  config: GatewayConfig;
  primarySessionKey: string;
  primarySession: AgentSession;
  createSession: GatewaySessionFactory;
  log?: (message: string) => void;
}
