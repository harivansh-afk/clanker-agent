import { describe, expect, it } from "vitest";
import { detectCue, parseAutoActivation, parseGrindStatus, parseStopCondition } from "../src/parser.js";

describe("pi-grind parser", () => {
	const now = new Date(2026, 2, 9, 9, 0, 0);
	const cues = ["don't stop", "keep going", "run until"];

	it("detects explicit grind cues", () => {
		expect(detectCue("Please keep going on this", cues)).toBe("keep going");
		expect(detectCue("Normal prompt", cues)).toBeNull();
	});

	it("parses time-based stop conditions", () => {
		const result = parseStopCondition("keep going until 5pm", now);
		expect(result.deadlineAt).toBe(new Date(2026, 2, 9, 17, 0, 0).toISOString());
		expect(result.completionCriterion).toBeNull();
	});

	it("parses criterion-based stop conditions when no time is found", () => {
		const result = parseStopCondition("don't stop until the migration is finished", now);
		expect(result.deadlineAt).toBeNull();
		expect(result.completionCriterion).toBe("the migration is finished");
	});

	it("parses full auto activation payloads", () => {
		const result = parseAutoActivation("run until tomorrow 5:30pm and finish the report", cues, now);

		expect(result).not.toBeNull();
		expect(result?.matchedCue).toBe("run until");
		expect(result?.stopCondition.deadlineAt).toBe(new Date(2026, 2, 10, 17, 30, 0).toISOString());
	});

	it("parses grind status trailers", () => {
		const payload = parseGrindStatus(
			'Work done.\n<grind_status>{"state":"continue","summary":"half done","nextAction":"finish tests"}</grind_status>',
		);

		expect(payload).toEqual({
			state: "continue",
			summary: "half done",
			nextAction: "finish tests",
		});
	});
});
