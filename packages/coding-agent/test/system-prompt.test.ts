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

      expect(prompt).toContain("# Tools\n\n(none)");
    });

    test("shows file paths guideline even with no tools", () => {
      const prompt = buildSystemPrompt({
        selectedTools: [],
        contextFiles: [],
        skills: [],
      });

      expect(prompt).toContain("Show file path");
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

  describe("context files", () => {
    test("adds soul guidance when SOUL.md is present", () => {
      const prompt = buildSystemPrompt({
        contextFiles: [
          {
            path: "/tmp/project/SOUL.md",
            content: "# Soul\n\nBe sharp.",
          },
        ],
        skills: [],
      });

      expect(prompt).toContain("SOUL.md** is who you are. Embody it");
      expect(prompt).toContain("## /tmp/project/SOUL.md");
    });

    test("includes file contents in context section", () => {
      const prompt = buildSystemPrompt({
        contextFiles: [
          {
            path: "/home/node/.clanker/workspace/USER.md",
            content: "# User\n\nLikes coffee.",
          },
        ],
        skills: [],
      });

      expect(prompt).toContain("USER.md** is what you know about your human");
      expect(prompt).toContain("Likes coffee.");
    });
  });
});
