import { parseDeadline } from "./time.js";
import {
	DEFAULT_COMPLETION_CRITERION,
	type GrindStatusPayload,
	type ParsedAutoActivation,
	type ParsedStopCondition,
} from "./types.js";

const GRIND_STATUS_PATTERN = /<grind_status>\s*(\{[\s\S]*?\})\s*<\/grind_status>/i;

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractUntilClause(text: string): string | null {
	const match = text.match(/\buntil\b([\s\S]+)$/i);
	if (!match) {
		return null;
	}
	const clause = match[1]?.trim();
	return clause ? clause : null;
}

export function detectCue(text: string, cuePatterns: readonly string[]): string | null {
	const normalized = normalizeText(text);
	for (const pattern of cuePatterns) {
		if (normalized.includes(normalizeText(pattern))) {
			return pattern;
		}
	}
	return null;
}

export function parseStopCondition(text: string, now: Date = new Date()): ParsedStopCondition {
	const clause = extractUntilClause(text);
	if (!clause) {
		return {
			deadlineAt: null,
			completionCriterion: DEFAULT_COMPLETION_CRITERION,
		};
	}

	const deadline = parseDeadline(clause, now);
	if (deadline) {
		return {
			deadlineAt: deadline.toISOString(),
			completionCriterion: null,
		};
	}

	return {
		deadlineAt: null,
		completionCriterion: clause,
	};
}

export function parseAutoActivation(
	text: string,
	cuePatterns: readonly string[],
	now: Date = new Date(),
): ParsedAutoActivation | null {
	const matchedCue = detectCue(text, cuePatterns);
	if (!matchedCue) {
		return null;
	}

	return {
		matchedCue,
		stopCondition: parseStopCondition(text, now),
	};
}

export function parseGrindStatus(text: string): GrindStatusPayload | null {
	const match = text.match(GRIND_STATUS_PATTERN);
	if (!match?.[1]) {
		return null;
	}

	try {
		const parsed = JSON.parse(match[1]) as Record<string, unknown>;
		const state = parsed.state;
		const summary = parsed.summary;
		const nextAction = parsed.nextAction;

		if (
			(state !== "continue" && state !== "done" && state !== "blocked") ||
			typeof summary !== "string" ||
			summary.trim().length === 0
		) {
			return null;
		}

		return {
			state,
			summary: summary.trim(),
			nextAction: typeof nextAction === "string" ? nextAction.trim() : undefined,
		};
	} catch {
		return null;
	}
}
