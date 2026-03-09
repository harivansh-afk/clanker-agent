import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
  describe("empty tools", () => {
    test("shows (none) for empty tools list", () => {
      const prompt = buildSystemPrompt({
        selectedTools: [],
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("Tools:\n(none)");
    });

    test("shows file paths guideline even with no tools", () => {
      const prompt = buildSystemPrompt({
        selectedTools: [],
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("Show file paths");
    });
  });

  describe("default tools", () => {
    test("includes all default tools", () => {
      const prompt = buildSystemPrompt({
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("- read:");
      expect(prompt).toContain("- bash:");
      expect(prompt).toContain("- edit:");
      expect(prompt).toContain("- write:");
    });
  });

  describe("custom tool snippets", () => {
    test("includes custom tools in available tools section", () => {
      const prompt = buildSystemPrompt({
        selectedTools: ["read", "dynamic_tool"],
        toolSnippets: {
          dynamic_tool: "Run dynamic test behavior",
        },
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
    });
  });

  describe("prompt guidelines", () => {
    test("appends promptGuidelines to default guidelines", () => {
      const prompt = buildSystemPrompt({
        selectedTools: ["read", "dynamic_tool"],
        promptGuidelines: ["Use dynamic_tool for project summaries."],
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("- Use dynamic_tool for project summaries.");
    });

    test("deduplicates and trims promptGuidelines", () => {
      const prompt = buildSystemPrompt({
        selectedTools: ["read", "dynamic_tool"],
        promptGuidelines: [
          "Use dynamic_tool for summaries.",
          "  Use dynamic_tool for summaries.  ",
          "   ",
        ],
        contextFiles: [],
        skills: [],
      });

      expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(
        1,
      );
    });
  });

  describe("SOUL.md context", () => {
    test("adds persona guidance when SOUL.md is present", () => {
      const prompt = buildSystemPrompt({
        contextFiles: [
          {
            path: "/tmp/project/SOUL.md",
            content: "# Soul\n\nBe sharp.",
          },
        ],
        skills: [],
      });

      expect(prompt).toContain("SOUL.md** defines your personality and tone");
      expect(prompt).toContain("## /tmp/project/SOUL.md");
    });

    test("adds companion context guidance for tools and bootstrap files", () => {
      const prompt = buildSystemPrompt({
        contextFiles: [
          {
            path: "/home/node/.pi/workspace/TOOLS.md",
            content: "# Tools\n\nUse ~/.pi/apps",
          },
          {
            path: "/home/node/.pi/workspace/BOOTSTRAP.md",
            content: "# Bootstrap\n\nDo the setup",
          },
        ],
        skills: [],
      });

      expect(prompt).toContain(
        "TOOLS.md** is your environment reference",
      );
      expect(prompt).toContain(
        "BOOTSTRAP.md** is your onboarding checklist",
      );
    });
  });
});
