import type { SessionEntry } from "@mariozechner/companion-coding-agent";
import { describe, expect, it } from "vitest";
import { createRunState, getLatestRunState, withLoopStatus, withStatus } from "../src/state.js";
import { GRIND_STATE_ENTRY_TYPE } from "../src/types.js";

describe("companion-grind state", () => {
	it("creates active run state", () => {
		const state = createRunState({
			activation: "explicit",
			goal: "Ship the refactor",
			sourcePrompt: "Don't stop until this is done",
			deadlineAt: null,
			completionCriterion: "this is done",
		});

		expect(state.status).toBe("active");
		expect(state.goal).toBe("Ship the refactor");
		expect(state.completionCriterion).toBe("this is done");
	});

	it("hydrates latest persisted state from session entries", () => {
		const older = createRunState({
			activation: "command",
			goal: "older",
			sourcePrompt: "older",
			deadlineAt: null,
			completionCriterion: null,
		});
		const newer = withStatus(older, "paused");

		const entries = [
			{
				type: "custom",
				id: "a",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: GRIND_STATE_ENTRY_TYPE,
				data: older,
			},
			{
				type: "custom",
				id: "b",
				parentId: "a",
				timestamp: new Date().toISOString(),
				customType: GRIND_STATE_ENTRY_TYPE,
				data: newer,
			},
		] satisfies SessionEntry[];

		expect(getLatestRunState(entries)?.status).toBe("paused");
	});

	it("applies loop results", () => {
		const state = createRunState({
			activation: "explicit",
			goal: "Ship it",
			sourcePrompt: "Ship it",
			deadlineAt: null,
			completionCriterion: null,
		});

		const next = withLoopStatus(state, {
			state: "done",
			summary: "finished",
			nextAction: "none",
		});

		expect(next.status).toBe("done");
		expect(next.lastCheckpoint).toBe("finished");
		expect(next.lastNextAction).toBe("none");
	});
});
