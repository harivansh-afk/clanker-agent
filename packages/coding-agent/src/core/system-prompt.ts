/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";
import { defaultCodingToolNames } from "./tools/index.js";

/** Tool descriptions for system prompt */
const toolDescriptions: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  browser:
    "Open websites, inspect pages with snapshot, click/fill/wait, take screenshots, and save/load browser state",
  edit: "Make surgical edits to files (find exact text and replace)",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

export interface BuildSystemPromptOptions {
  /** Custom system prompt (replaces default). */
  customPrompt?: string;
  /** Tools to include in prompt. Default: coding tools including browser */
  selectedTools?: string[];
  /** Optional one-line tool snippets keyed by tool name. */
  toolSnippets?: Record<string, string>;
  /** Additional guideline bullets appended to the default system prompt guidelines. */
  promptGuidelines?: string[];
  /** Text to append to system prompt. */
  appendSystemPrompt?: string;
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Pre-loaded context files. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** Pre-loaded skills. */
  skills?: Skill[];
}

function buildProjectContextSection(
  contextFiles: Array<{ path: string; content: string }>,
): string {
  if (contextFiles.length === 0) {
    return "";
  }

  const hasSoulFile = contextFiles.some(
    ({ path }) =>
      path.replaceAll("\\", "/").endsWith("/SOUL.md") || path === "SOUL.md",
  );
  const hasContextFile = (filename: string) =>
    contextFiles.some(
      ({ path }) =>
        path.replaceAll("\\", "/").endsWith(`/${filename}`) ||
        path === filename,
    );
  let section = "\n\n# Project Context\n\n";
  section += "Project-specific instructions and guidelines:\n";
  if (hasSoulFile) {
    section +=
      "\nIf SOUL.md is present, embody its persona and tone. Avoid generic assistant filler and follow its guidance unless higher-priority instructions override it.\n";
  }
  if (hasContextFile("IDENTITY.md")) {
    section +=
      "\nIf IDENTITY.md is present, treat it as the agent's self-description and stay consistent with it.\n";
  }
  if (hasContextFile("USER.md")) {
    section +=
      "\nIf USER.md is present, use it as durable context about the user and avoid re-asking for facts already captured there.\n";
  }
  if (hasContextFile("MEMORY.md")) {
    section +=
      "\nIf MEMORY.md is present, use it as long-term memory and keep it aligned with durable user or project context when the task calls for it.\n";
  }
  if (hasContextFile("TOOLS.md")) {
    section +=
      "\nIf TOOLS.md is present, treat it as the source of truth for the current sandbox filesystem, app locations, and environment-specific workflow details.\n";
  }
  if (hasContextFile("BOOTSTRAP.md")) {
    section +=
      "\nIf BOOTSTRAP.md is present, treat it as an actionable onboarding task list and execute it before drifting into unrelated work.\n";
  }
  section += "\n";
  for (const { path: filePath, content } of contextFiles) {
    section += `## ${filePath}\n\n${content}\n\n`;
  }

  return section;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(
  options: BuildSystemPromptOptions = {},
): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles: providedContextFiles,
    skills: providedSkills,
  } = options;
  const resolvedCwd = cwd ?? process.cwd();

  const now = new Date();
  const dateTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];

  if (customPrompt) {
    let prompt = customPrompt;

    if (appendSection) {
      prompt += appendSection;
    }

    // Append project context files
    prompt += buildProjectContextSection(contextFiles);

    // Append skills section (only if read tool is available)
    const customPromptHasRead =
      !selectedTools || selectedTools.includes("read");
    if (customPromptHasRead && skills.length > 0) {
      prompt += formatSkillsForPrompt(skills);
    }

    // Add date/time and working directory last
    prompt += `\nCurrent date and time: ${dateTime}`;
    prompt += `\nCurrent working directory: ${resolvedCwd}`;

    return prompt;
  }

  // Get absolute paths to documentation
  const readmePath = getReadmePath();
  const docsPath = getDocsPath();

  // Build tools list based on selected tools.
  // Built-ins use toolDescriptions. Custom tools can provide one-line snippets.
  const tools = selectedTools ?? defaultCodingToolNames;
  const toolsList =
    tools.length > 0
      ? tools
          .map((name) => {
            const snippet =
              toolSnippets?.[name] ?? toolDescriptions[name] ?? name;
            return `- ${name}: ${snippet}`;
          })
          .join("\n")
      : "(none)";

  // Build guidelines based on which tools are actually available
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string): void => {
    if (guidelinesSet.has(guideline)) {
      return;
    }
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  const hasBash = tools.includes("bash");
  const hasBrowser = tools.includes("browser");
  const hasEdit = tools.includes("edit");
  const hasWrite = tools.includes("write");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");
  const hasRead = tools.includes("read");

  // File exploration guidelines
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  // Read before edit guideline
  if (hasRead && hasEdit) {
    addGuideline(
      "Use read to examine files before editing. You must use this tool instead of cat or sed.",
    );
  }

  // Edit guideline
  if (hasEdit) {
    addGuideline("Use edit for precise changes (old text must match exactly)");
  }

  // Write guideline
  if (hasWrite) {
    addGuideline("Use write only for new files or complete rewrites");
  }

  if (hasBrowser) {
    addGuideline(
      "Use browser for website tasks. Open the page, use snapshot to inspect interactive elements, then click, fill, wait, or screenshot as needed",
    );
  }

  // Output guideline (only when actually writing or executing)
  if (hasEdit || hasWrite) {
    addGuideline(
      "When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
    );
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }

  // Always include these
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

  if (appendSection) {
    prompt += appendSection;
  }

  // Append project context files
  prompt += buildProjectContextSection(contextFiles);

  // Append skills section (only if read tool is available)
  if (hasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  // Add date/time and working directory last
  prompt += `\nCurrent date and time: ${dateTime}`;
  prompt += `\nCurrent working directory: ${resolvedCwd}`;

  return prompt;
}
