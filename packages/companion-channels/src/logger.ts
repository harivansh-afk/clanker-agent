import type { ExtensionAPI } from "@mariozechner/companion-coding-agent";

const CHANNEL = "channels";

export function createLogger(companion: ExtensionAPI) {
  return (event: string, data: unknown, level = "INFO") =>
    companion.events.emit("log", { channel: CHANNEL, event, level, data });
}
