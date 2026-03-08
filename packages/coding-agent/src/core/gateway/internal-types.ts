import type { AgentSession } from "../agent-session.js";
import type {
  GatewayMessageRequest,
  GatewayMessageResult,
  GatewaySessionSnapshot,
} from "./types.js";

export interface GatewayQueuedMessage {
  request: GatewayMessageRequest;
  resolve: (result: GatewayMessageResult) => void;
  onStart?: () => void;
  onFinish?: () => void;
}

export type GatewayEvent =
  | { type: "hello"; sessionKey: string; snapshot: GatewaySessionSnapshot }
  | {
      type: "session_state";
      sessionKey: string;
      snapshot: GatewaySessionSnapshot;
    }
  | { type: "turn_start"; sessionKey: string }
  | { type: "turn_end"; sessionKey: string }
  | { type: "message_start"; sessionKey: string; role?: string }
  | { type: "token"; sessionKey: string; delta: string; contentIndex: number }
  | {
      type: "thinking";
      sessionKey: string;
      delta: string;
      contentIndex: number;
    }
  | {
      type: "tool_start";
      sessionKey: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_update";
      sessionKey: string;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "tool_complete";
      sessionKey: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "message_complete"; sessionKey: string; text: string }
  | { type: "error"; sessionKey: string; error: string }
  | { type: "aborted"; sessionKey: string };

export interface ManagedGatewaySession {
  sessionKey: string;
  session: AgentSession;
  queue: GatewayQueuedMessage[];
  processing: boolean;
  createdAt: number;
  lastActiveAt: number;
  listeners: Set<(event: GatewayEvent) => void>;
  unsubscribe: () => void;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
