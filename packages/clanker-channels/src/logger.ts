import type { ExtensionAPI } from "@mariozechner/clanker-coding-agent";

const CHANNEL = "channels";

export function createLogger(clanker: ExtensionAPI) {
  return (event: string, data: unknown, level = "INFO") =>
    clanker.events.emit("log", { channel: CHANNEL, event, level, data });
}
