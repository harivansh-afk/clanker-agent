export const GRIND_SETTINGS_KEY = "companion-grind";
export const GRIND_STATE_ENTRY_TYPE = "companion-grind/state";
export const DEFAULT_COMPLETION_CRITERION = "finish the requested task";
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MAX_PARSE_FAILURES = 2;

export type GrindActivation = "explicit" | "command";
export type GrindCueMode = "explicit-only";
export type GrindInterventionMode = "pause";
export type GrindRunStatus = "active" | "paused" | "done" | "blocked" | "expired" | "stopped";
export type GrindLoopState = "continue" | "done" | "blocked";

export interface GrindConfig {
	enabled: boolean;
	pollIntervalMs: number;
	cueMode: GrindCueMode;
	requireDaemon: boolean;
	userIntervention: GrindInterventionMode;
	cuePatterns: string[];
}

export interface ParsedStopCondition {
	deadlineAt: string | null;
	completionCriterion: string | null;
}

export interface ParsedAutoActivation {
	matchedCue: string;
	stopCondition: ParsedStopCondition;
}

export interface GrindStatusPayload {
	state: GrindLoopState;
	summary: string;
	nextAction?: string;
}

export interface GrindRunState {
	version: 1;
	runId: string;
	activation: GrindActivation;
	status: GrindRunStatus;
	goal: string;
	sourcePrompt: string;
	deadlineAt: string | null;
	completionCriterion: string | null;
	lastCheckpoint: string | null;
	lastNextAction: string | null;
	pendingRepair: boolean;
	consecutiveParseFailures: number;
	updatedAt: string;
}
