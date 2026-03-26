/**
 * clanker-channels — Two-way channel extension for clanker.
 *
 * Routes messages between agents and external services
 * (Telegram, webhooks, custom adapters).
 *
 * Built-in adapters: telegram (bidirectional), webhook (outgoing)
 * Custom adapters: register via clanker.events.emit("channel:register", ...)
 *
 * Chat bridge: when enabled, incoming messages are routed to the agent
 * as isolated subprocess prompts and responses are sent back. Enable via:
 *   - --chat-bridge flag
 *   - /chat-bridge on command
 *   - settings.json: { "clanker-channels": { "bridge": { "enabled": true } } }
 *
 * Config in settings.json under "clanker-channels":
 * {
 *   "clanker-channels": {
 *     "adapters": {
 *       "telegram": { "type": "telegram", "botToken": "your-telegram-bot-token", "polling": true }
 *     },
 *     "routes": {
 *       "ops": { "adapter": "telegram", "recipient": "-100987654321" }
 *     },
 *     "bridge": {
 *       "enabled": false,
 *       "maxQueuePerSender": 5,
 *       "timeoutMs": 300000,
 *       "maxConcurrent": 2,
 *       "typingIndicators": true,
 *       "commands": true
 *     }
 *   }
 * }
 */

import type { ExtensionAPI } from "@mariozechner/clanker-coding-agent";
import { ChatBridge } from "./bridge/bridge.js";
import { loadConfig } from "./config.js";
import { registerChannelEvents, setBridge } from "./events.js";
import { createLogger } from "./logger.js";
import { ChannelRegistry } from "./registry.js";
import { registerChannelTool } from "./tool.js";

export default function (clanker: ExtensionAPI) {
  const log = createLogger（clanker）;
  const registry = new ChannelRegistry();
  registry.setLogger(log);
  let bridge: ChatBridge | null = null;

  // ── Flag: --chat-bridge ───────────────────────────────────

  clanker.registerFlag("chat-bridge", {
    description:
      "Enable the chat bridge on startup (incoming messages → agent → reply)",
    type: "boolean",
    default: false,
  });

  // ── Event API + cron integration ──────────────────────────

  registerChannelEvents(clanker, registry);

  // ── Lifecycle ─────────────────────────────────────────────

  clanker.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    await registry.loadConfig(config, ctx.cwd);

    const errors = registry.getErrors();
    for (const err of errors) {
      ctx.ui.notify(`clanker-channels: ${err.adapter}: ${err.error}`, "warning");
      log("adapter-error", { adapter: err.adapter, error: err.error }, "ERROR");
    }
    log("init", {
      adapters: Object.keys(config.adapters ?? {}),
      routes: Object.keys(config.routes ?? {}),
    });

    // Start incoming/bidirectional adapters
    await registry.startListening();

    const startErrors = registry
      .getErrors()
      .filter((e) => e.error.startsWith("Failed to start"));
    for (const err of startErrors) {
      ctx.ui.notify(`clanker-channels: ${err.adapter}: ${err.error}`, "warning");
    }

    // Initialize bridge
    bridge = new ChatBridge(config.bridge, ctx.cwd, registry, clanker.events, log);
    setBridge(bridge);

    const flagEnabled = clanker.getFlag("--chat-bridge");
    if (flagEnabled || config.bridge?.enabled) {
      bridge.start();
      log("bridge-start", {});
      ctx.ui.notify("clanker-channels: Chat bridge started", "info");
    }
  });

  clanker.on("session_shutdown", async () => {
    if (bridge?.isActive()) log("bridge-stop", {});
    bridge?.stop();
    setBridge(null);
    await registry.stopAll();
  });

  // ── Command: /chat-bridge ─────────────────────────────────

  clanker.registerCommand("chat-bridge", {
    description: "Manage chat bridge: /chat-bridge [on|off|status]",
    getArgumentCompletions: (prefix: string) => {
      return ["on", "off", "status"]
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const cmd = args?.trim().toLowerCase();

      if (cmd === "on") {
        if (!bridge) {
          ctx.ui.notify(
            "Chat bridge not initialized — no channel config?",
            "warning",
          );
          return;
        }
        if (bridge.isActive()) {
          ctx.ui.notify("Chat bridge is already running.", "info");
          return;
        }
        bridge.start();
        ctx.ui.notify("✓ Chat bridge started", "info");
        return;
      }

      if (cmd === "off") {
        if (!bridge?.isActive()) {
          ctx.ui.notify("Chat bridge is not running.", "info");
          return;
        }
        bridge.stop();
        ctx.ui.notify("✓ Chat bridge stopped", "info");
        return;
      }

      // Default: status
      if (!bridge) {
        ctx.ui.notify("Chat bridge: not initialized", "info");
        return;
      }

      const stats = bridge.getStats();
      const lines = [
        `Chat bridge: ${stats.active ? "🟢 Active" : "⚪ Inactive"}`,
        `Sessions: ${stats.sessions}`,
        `Active prompts: ${stats.activePrompts}`,
        `Queued: ${stats.totalQueued}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── LLM tool ──────────────────────────────────────────────

  registerChannelTool(clanker, registry);
}
