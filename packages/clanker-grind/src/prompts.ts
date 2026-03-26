import type { GrindRunState } from "./types.js";

function describeStopCondition(state: GrindRunState): string {
	const parts: string[] = [];
	if (state.deadlineAt) {
		parts.push(`Hard deadline: ${state.deadlineAt}.`);
	}
	if (state.completionCriterion) {
		parts.push(`Completion criterion: ${state.completionCriterion}.`);
	}
	return parts.join(" ");
}

export function buildSystemPromptAddon(state: GrindRunState): string {
	const lines = ["Grind mode is active for this session.", `Primary goal: ${state.goal}`];

	const stopCondition = describeStopCondition(state);
	if (stopCondition) {
		lines.push(stopCondition);
	}

	lines.push("Keep working until the task is done, blocked, or the deadline passes.");
	lines.push(
		'Every response must end with <grind_status>{"state":"continue|done|blocked","summary":"...","nextAction":"..."}</grind_status>.',
	);

	return lines.join("\n");
}

export function buildContinuationPrompt(state: GrindRunState): string {
	const parts = ["Continue the active grind run.", `Goal: ${state.goal}`];

	const stopCondition = describeStopCondition(state);
	if (stopCondition) {
		parts.push(stopCondition);
	}
	if (state.lastCheckpoint) {
		parts.push(`Last checkpoint: ${state.lastCheckpoint}`);
	}
	if (state.lastNextAction) {
		parts.push(`Planned next action: ${state.lastNextAction}`);
	}

	parts.push(
		'End with <grind_status>{"state":"continue|done|blocked","summary":"...","nextAction":"..."}</grind_status>.',
	);

	return parts.join("\n\n");
}

export function buildRepairPrompt(state: GrindRunState): string {
	return [
		"Your previous grind-mode response did not include a valid <grind_status> trailer.",
		"Do not restart the task from scratch.",
		state.lastCheckpoint ? `Latest known checkpoint: ${state.lastCheckpoint}` : "",
		'Reply with a corrected trailer only, or a very short update plus <grind_status>{"state":"continue|done|blocked","summary":"...","nextAction":"..."}</grind_status>.',
	]
		.filter(Boolean)
		.join("\n\n");
}
