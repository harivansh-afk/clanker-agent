import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@mariozechner/companion-coding-agent";
import {
	GRIND_STATE_ENTRY_TYPE,
	type GrindActivation,
	type GrindRunState,
	type GrindRunStatus,
	type GrindStatusPayload,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isGrindRunStatus(value: unknown): value is GrindRunStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "done" ||
		value === "blocked" ||
		value === "expired" ||
		value === "stopped"
	);
}

function isGrindActivation(value: unknown): value is GrindActivation {
	return value === "explicit" || value === "command";
}

function isNullableString(value: unknown): value is string | null {
	return typeof value === "string" || value === null;
}

export function createRunState(input: {
	activation: GrindActivation;
	goal: string;
	sourcePrompt: string;
	deadlineAt: string | null;
	completionCriterion: string | null;
}): GrindRunState {
	const now = new Date().toISOString();
	return {
		version: 1,
		runId: randomUUID(),
		activation: input.activation,
		status: "active",
		goal: input.goal,
		sourcePrompt: input.sourcePrompt,
		deadlineAt: input.deadlineAt,
		completionCriterion: input.completionCriterion,
		lastCheckpoint: null,
		lastNextAction: null,
		pendingRepair: false,
		consecutiveParseFailures: 0,
		updatedAt: now,
	};
}

export function isValidRunState(value: unknown): value is GrindRunState {
	if (!isRecord(value)) {
		return false;
	}

	return (
		value.version === 1 &&
		typeof value.runId === "string" &&
		isGrindActivation(value.activation) &&
		isGrindRunStatus(value.status) &&
		typeof value.goal === "string" &&
		typeof value.sourcePrompt === "string" &&
		isNullableString(value.deadlineAt) &&
		isNullableString(value.completionCriterion) &&
		isNullableString(value.lastCheckpoint) &&
		isNullableString(value.lastNextAction) &&
		typeof value.pendingRepair === "boolean" &&
		typeof value.consecutiveParseFailures === "number" &&
		typeof value.updatedAt === "string"
	);
}

export function getLatestRunState(entries: readonly SessionEntry[]): GrindRunState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== GRIND_STATE_ENTRY_TYPE) {
			continue;
		}
		if (isValidRunState(entry.data)) {
			return entry.data;
		}
	}
	return null;
}

export function withStatus(
	state: GrindRunState,
	status: GrindRunStatus,
	overrides: Partial<GrindRunState> = {},
): GrindRunState {
	return {
		...state,
		...overrides,
		status,
		updatedAt: new Date().toISOString(),
	};
}

export function withLoopStatus(state: GrindRunState, payload: GrindStatusPayload): GrindRunState {
	return {
		...state,
		status: payload.state === "continue" ? "active" : payload.state === "done" ? "done" : "blocked",
		lastCheckpoint: payload.summary,
		lastNextAction: payload.nextAction ?? null,
		pendingRepair: false,
		consecutiveParseFailures: 0,
		updatedAt: new Date().toISOString(),
	};
}
