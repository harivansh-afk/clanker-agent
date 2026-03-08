import type { AgentSession } from "../agent-session.js";

export function extractMessageText(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        "text" in part &&
        part.type === "text"
      );
    })
    .map((part) => part.text)
    .join("");
}

export function getLastAssistantText(session: AgentSession): string {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message.role === "assistant") {
      return extractMessageText(message);
    }
  }
  return "";
}
