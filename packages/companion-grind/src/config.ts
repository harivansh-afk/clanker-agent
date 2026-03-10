import { getAgentDir, SettingsManager } from "@mariozechner/companion-coding-agent";
import { DEFAULT_POLL_INTERVAL_MS, GRIND_SETTINGS_KEY, type GrindConfig } from "./types.js";

const DEFAULT_CUE_PATTERNS = [
	"don't stop",
	"keep going",
	"keep running",
	"run until",
	"until done",
	"stay on this until",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : undefined;
}

export function loadConfig(cwd: string): GrindConfig {
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
	const projectSettings = settingsManager.getProjectSettings() as Record<string, unknown>;

	const globalConfig = isRecord(globalSettings[GRIND_SETTINGS_KEY]) ? globalSettings[GRIND_SETTINGS_KEY] : {};
	const projectConfig = isRecord(projectSettings[GRIND_SETTINGS_KEY]) ? projectSettings[GRIND_SETTINGS_KEY] : {};

	const cuePatterns =
		asStringArray(projectConfig.cuePatterns) ?? asStringArray(globalConfig.cuePatterns) ?? DEFAULT_CUE_PATTERNS;

	const pollIntervalMsRaw =
		typeof projectConfig.pollIntervalMs === "number"
			? projectConfig.pollIntervalMs
			: typeof globalConfig.pollIntervalMs === "number"
				? globalConfig.pollIntervalMs
				: DEFAULT_POLL_INTERVAL_MS;

	return {
		enabled:
			typeof projectConfig.enabled === "boolean"
				? projectConfig.enabled
				: typeof globalConfig.enabled === "boolean"
					? globalConfig.enabled
					: true,
		pollIntervalMs:
			Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0
				? Math.max(1_000, Math.floor(pollIntervalMsRaw))
				: DEFAULT_POLL_INTERVAL_MS,
		cueMode: "explicit-only",
		requireDaemon:
			typeof projectConfig.requireDaemon === "boolean"
				? projectConfig.requireDaemon
				: typeof globalConfig.requireDaemon === "boolean"
					? globalConfig.requireDaemon
					: true,
		userIntervention: "pause",
		cuePatterns,
	};
}
