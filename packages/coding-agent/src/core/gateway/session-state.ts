import type { AgentMessage } from "@mariozechner/companion-agent-core";
import type { HistoryMessage, HistoryPart } from "./types.js";

export interface GatewayTransientToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  timestamp: number;
}

type TeamActivityMember = Extract<
  HistoryPart,
  { type: "teamActivity" }
>["members"][number];

function isSupportedHistoryRole(
  role: AgentMessage["role"],
): role is "user" | "assistant" | "toolResult" {
  return role === "user" || role === "assistant" || role === "toolResult";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTeamActivityMembers(value: unknown): TeamActivityMember[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((member) => {
      const id = typeof member.id === "string" ? member.id : "";
      if (!id) {
        return null;
      }

      return {
        id,
        name: typeof member.name === "string" ? member.name : "Teammate",
        ...(typeof member.role === "string" ? { role: member.role } : {}),
        status: typeof member.status === "string" ? member.status : "running",
        ...(typeof member.message === "string"
          ? { message: member.message }
          : {}),
      };
    })
    .filter((member): member is TeamActivityMember => member !== null);
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
    const content: unknown = msg.content;
    if (!Array.isArray(content)) return [];
    const parts: HistoryPart[] = [];
    for (const contentPart of content) {
      if (!isRecord(contentPart) || typeof contentPart.type !== "string") {
        continue;
      }

      switch (contentPart.type) {
        case "text":
          if (typeof contentPart.text === "string") {
            parts.push({
              type: "text",
              text: contentPart.text,
            });
          }
          break;
        case "thinking":
          if (typeof contentPart.thinking === "string") {
            parts.push({
              type: "reasoning",
              text: contentPart.thinking,
            });
          }
          break;
        case "toolCall":
          if (
            typeof contentPart.id === "string" &&
            typeof contentPart.name === "string"
          ) {
            parts.push({
              type: "tool-invocation",
              toolCallId: contentPart.id,
              toolName: contentPart.name,
              args: contentPart.arguments,
              state: "call",
            });
          }
          break;
        case "teamActivity": {
          const teamId =
            typeof contentPart.teamId === "string" ? contentPart.teamId : "";
          if (!teamId) {
            break;
          }
          parts.push({
            type: "teamActivity",
            teamId,
            status:
              typeof contentPart.status === "string"
                ? contentPart.status
                : "running",
            members: normalizeTeamActivityMembers(contentPart.members),
          });
          break;
        }
        case "image":
          if (typeof contentPart.url === "string") {
            parts.push({
              type: "media",
              url: contentPart.url,
              ...(typeof contentPart.mimeType === "string"
                ? { mimeType: contentPart.mimeType }
                : {}),
            });
          }
          break;
        case "error":
          if (typeof contentPart.message === "string") {
            parts.push({
              type: "error",
              code:
                typeof contentPart.code === "string"
                  ? contentPart.code
                  : "unknown",
              message: contentPart.message,
            });
          }
          break;
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
