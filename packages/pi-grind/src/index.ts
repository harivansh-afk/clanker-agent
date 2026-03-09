import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { parseAutoActivation, parseGrindStatus, parseStopCondition } from "./parser.js";
import { buildContinuationPrompt, buildRepairPrompt, buildSystemPromptAddon } from "./prompts.js";
import { createRunState, getLatestRunState, withLoopStatus, withStatus } from "./state.js";
import {
	DEFAULT_COMPLETION_CRITERION,
	GRIND_STATE_ENTRY_TYPE,
	type GrindConfig,
	type GrindRunState,
	MAX_PARSE_FAILURES,
} from "./types.js";

function isDaemonRuntime(): boolean {
	if (process.env.PI_GRIND_FORCE_DAEMON === "1") {
		return true;
	}
	if (process.env.PI_GRIND_FORCE_DAEMON === "0") {
		return false;
	}

	return (
		process.argv.includes("daemon") ||
		process.argv.includes("gateway") ||
		Boolean(process.env.PI_GATEWAY_BIND) ||
		Boolean(process.env.PI_GATEWAY_PORT) ||
		Boolean(process.env.PI_GATEWAY_TOKEN)
	);
}

function getAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}

	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") {
			parts.push(part.text);
		}
	}
	return parts.join("\n");
}

function isGrindCommand(text: string): boolean {
	return text.trim().toLowerCase().startsWith("/grind");
}

function note(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "info");
	}
}

function readState(ctx: ExtensionContext): GrindRunState | null {
	return getLatestRunState(ctx.sessionManager.getEntries());
}

function persistState(pi: ExtensionAPI, ctx: ExtensionContext, state: GrindRunState): GrindRunState {
	pi.appendEntry(GRIND_STATE_ENTRY_TYPE, state);
	if (ctx.hasUI) {
		ctx.ui.setStatus("pi-grind", state.status === "active" ? "GRIND" : state.status.toUpperCase());
	}
	return state;
}

function clearUiStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) {
		ctx.ui.setStatus("pi-grind", "");
	}
}

function maybeExpireRun(pi: ExtensionAPI, ctx: ExtensionContext, state: GrindRunState): GrindRunState | null {
	if (!state.deadlineAt) {
		return state;
	}

	if (Date.parse(state.deadlineAt) > Date.now()) {
		return state;
	}

	const expired = withStatus(state, "expired", {
		lastCheckpoint: "Grind run expired at the configured deadline.",
		lastNextAction: null,
		pendingRepair: false,
	});
	persistState(pi, ctx, expired);
	note(ctx, "Grind mode stopped: deadline reached.");
	return expired;
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}
		if (quote && char === quote) {
			quote = null;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

function parseStartCommandArgs(args: string): {
	goal: string | null;
	until: string | null;
	criterion: string | null;
} {
	const tokens = tokenizeArgs(args);
	const goalParts: string[] = [];
	let until: string | null = null;
	let criterion: string | null = null;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--until") {
			until = tokens[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (token.startsWith("--until=")) {
			until = token.slice("--until=".length) || null;
			continue;
		}
		if (token === "--criterion") {
			criterion = tokens[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (token.startsWith("--criterion=")) {
			criterion = token.slice("--criterion=".length) || null;
			continue;
		}

		goalParts.push(token);
	}

	return {
		goal: goalParts.length > 0 ? goalParts.join(" ") : null,
		until,
		criterion,
	};
}

function startRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: GrindConfig,
	input: {
		activation: "explicit" | "command";
		goal: string;
		sourcePrompt: string;
		deadlineAt: string | null;
		completionCriterion: string | null;
	},
): GrindRunState | null {
	if (!config.enabled) {
		note(ctx, "Grind mode is disabled in settings.");
		return null;
	}

	if (config.requireDaemon && !isDaemonRuntime()) {
		note(ctx, "Durable grind mode requires `pi daemon`.");
		return null;
	}

	const nextState = createRunState(input);
	persistState(pi, ctx, nextState);
	note(ctx, "Grind mode activated.");
	return nextState;
}

export default function grind(pi: ExtensionAPI) {
	let config: GrindConfig | null = null;
	let state: GrindRunState | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	const getConfig = (cwd: string): GrindConfig => {
		config = loadConfig(cwd);
		return config;
	};

	const stopHeartbeat = () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
	};

	const ensureHeartbeat = (ctx: ExtensionContext) => {
		stopHeartbeat();
		heartbeat = setInterval(() => {
			if (!config || !state || state.status !== "active") {
				return;
			}
			if (config.requireDaemon && !isDaemonRuntime()) {
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				return;
			}

			const expired = maybeExpireRun(pi, ctx, state);
			state = expired;
			if (!state || state.status !== "active") {
				return;
			}

			if (state.pendingRepair) {
				pi.sendUserMessage(buildRepairPrompt(state), {
					deliverAs: "followUp",
				});
			} else {
				pi.sendUserMessage(buildContinuationPrompt(state), {
					deliverAs: "followUp",
				});
			}
		}, config?.pollIntervalMs ?? 30_000);
		heartbeat.unref?.();
	};

	const registerCommand = (name: string, command: Omit<RegisteredCommand, "name">) => {
		pi.registerCommand(name, command);
	};

	registerCommand("grind", {
		description: "Manage grind mode: /grind [start|status|pause|resume|stop]",
		getArgumentCompletions: (prefix: string) =>
			["start", "status", "pause", "resume", "stop"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const currentConfig = getConfig(ctx.cwd);
			const trimmed = args?.trim() ?? "";
			const [command] = tokenizeArgs(trimmed);
			const subcommand = command?.toLowerCase() ?? "status";
			const restArgs = trimmed.slice(command?.length ?? 0).trim();

			if (subcommand === "start") {
				const parsed = parseStartCommandArgs(restArgs);
				if (!parsed.goal) {
					note(ctx, "Usage: /grind start [--until <time>] [--criterion <text>] <goal>");
					return;
				}

				const parsedUntil = parsed.until
					? parseStopCondition(`until ${parsed.until}`)
					: { deadlineAt: null, completionCriterion: null };

				const nextState = startRun(pi, ctx, currentConfig, {
					activation: "command",
					goal: parsed.goal,
					sourcePrompt: parsed.goal,
					deadlineAt: parsedUntil.deadlineAt,
					completionCriterion: parsed.criterion ?? parsedUntil.completionCriterion ?? DEFAULT_COMPLETION_CRITERION,
				});
				state = nextState;
				if (state) {
					pi.sendUserMessage(parsed.goal, { deliverAs: "followUp" });
				}
				return;
			}

			if (subcommand === "status") {
				const currentState = state ?? readState(ctx);
				if (!currentState) {
					note(ctx, "Grind mode is not active in this session.");
					return;
				}

				note(
					ctx,
					[
						`status=${currentState.status}`,
						`goal=${currentState.goal}`,
						currentState.deadlineAt ? `deadline=${currentState.deadlineAt}` : null,
						currentState.completionCriterion ? `criterion=${currentState.completionCriterion}` : null,
						currentState.lastCheckpoint ? `checkpoint=${currentState.lastCheckpoint}` : null,
					]
						.filter(Boolean)
						.join("\n"),
				);
				return;
			}

			if (subcommand === "pause") {
				if (!state) {
					state = readState(ctx);
				}
				if (!state) {
					note(ctx, "No grind run to pause.");
					return;
				}
				state = persistState(pi, ctx, withStatus(state, "paused", { pendingRepair: false }));
				note(ctx, "Grind mode paused.");
				return;
			}

			if (subcommand === "resume") {
				if (!state) {
					state = readState(ctx);
				}
				if (!state) {
					note(ctx, "No grind run to resume.");
					return;
				}
				if (currentConfig.requireDaemon && !isDaemonRuntime()) {
					note(ctx, "Durable grind mode requires `pi daemon`.");
					return;
				}
				state = persistState(pi, ctx, withStatus(state, "active"));
				note(ctx, "Grind mode resumed.");
				pi.sendUserMessage(buildContinuationPrompt(state), {
					deliverAs: "followUp",
				});
				return;
			}

			if (subcommand === "stop") {
				if (!state) {
					state = readState(ctx);
				}
				if (!state) {
					note(ctx, "No grind run to stop.");
					return;
				}
				state = persistState(
					pi,
					ctx,
					withStatus(state, "stopped", {
						pendingRepair: false,
						lastNextAction: null,
					}),
				);
				note(ctx, "Grind mode stopped.");
				clearUiStatus(ctx);
				return;
			}

			note(ctx, `Unknown grind command: ${subcommand}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state = readState(ctx);
		if (state && ctx.hasUI) {
			ctx.ui.setStatus("pi-grind", state.status === "active" ? "GRIND" : state.status.toUpperCase());
		}
		if (config.enabled) {
			ensureHeartbeat(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		stopHeartbeat();
	});

	pi.on("input", async (event, ctx) => {
		const currentConfig = getConfig(ctx.cwd);
		if (!currentConfig.enabled || event.source === "extension") {
			return { action: "continue" } as const;
		}

		const currentState = state ?? readState(ctx);

		if (currentState && currentState.status === "active" && !isGrindCommand(event.text)) {
			const activation = parseAutoActivation(event.text, currentConfig.cuePatterns);
			if (!activation) {
				if (currentConfig.userIntervention === "pause") {
					state = persistState(pi, ctx, withStatus(currentState, "paused", { pendingRepair: false }));
					note(ctx, "Grind mode paused for manual input.");
				}
				return { action: "continue" } as const;
			}
		}

		const activation = parseAutoActivation(event.text, currentConfig.cuePatterns);
		if (!activation) {
			return { action: "continue" } as const;
		}

		state = startRun(pi, ctx, currentConfig, {
			activation: "explicit",
			goal: event.text,
			sourcePrompt: event.text,
			deadlineAt: activation.stopCondition.deadlineAt,
			completionCriterion: activation.stopCondition.completionCriterion,
		});

		return { action: "continue" } as const;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state = state ?? readState(ctx);
		if (!state || state.status !== "active") {
			return;
		}

		const expired = maybeExpireRun(pi, ctx, state);
		state = expired;
		if (!state || state.status !== "active") {
			return;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAddon(state)}`,
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		state = state ?? readState(ctx);
		if (!state || state.status !== "active") {
			return;
		}

		const expired = maybeExpireRun(pi, ctx, state);
		state = expired;
		if (!state || state.status !== "active") {
			return;
		}

		const text = getAssistantText(event.message);
		const parsed = parseGrindStatus(text);

		if (!parsed) {
			if (state.consecutiveParseFailures + 1 >= MAX_PARSE_FAILURES) {
				state = persistState(
					pi,
					ctx,
					withStatus(state, "blocked", {
						pendingRepair: false,
						consecutiveParseFailures: state.consecutiveParseFailures + 1,
						lastCheckpoint: "Blocked: assistant failed to return a valid <grind_status> trailer.",
						lastNextAction: null,
					}),
				);
				note(ctx, "Grind mode blocked: invalid grind status trailer.");
				return;
			}

			state = persistState(pi, ctx, {
				...state,
				pendingRepair: true,
				consecutiveParseFailures: state.consecutiveParseFailures + 1,
				updatedAt: new Date().toISOString(),
			});
			return;
		}

		state = persistState(pi, ctx, withLoopStatus(state, parsed));
		if (state.status !== "active") {
			note(ctx, `Grind mode ${state.status}.`);
			if (state.status !== "paused") {
				clearUiStatus(ctx);
			}
		}
	});
}
