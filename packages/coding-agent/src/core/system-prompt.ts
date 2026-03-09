/**
 * System prompt construction and project context loading
 */

import { formatSkillsForPrompt, type Skill } from "./skills.js";
import { defaultCodingToolNames } from "./tools/index.js";

/** Tool descriptions for system prompt */
const toolDescriptions: Record<string, string> = {
  read: "Read file contents (always use instead of cat/head/tail)",
  bash: "Run shell commands",
  browser:
    "Browse the web: open, snapshot, click, fill, wait, screenshot, save/load state",
  edit: "Surgical file edits (find exact text, replace it)",
  write: "Create new files or completely rewrite existing ones",
  grep: "Search file contents by regex (respects .gitignore)",
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

  const hasFile = (filename: string) =>
    contextFiles.some(
      ({ path }) =>
        path.replaceAll("\\", "/").endsWith(`/${filename}`) ||
        path === filename,
    );

  let section = "\n\n# Context\n\n";
  section +=
    "These files define who you are, what you know, and how you operate.\n";

  const guides: string[] = [];

  if (hasFile("SOUL.md")) {
    guides.push(
      "**SOUL.md** defines your personality and tone. Embody it fully.",
    );
  }
  if (hasFile("USER.md")) {
    guides.push(
      "**USER.md** is what you know about your user. Update it when you learn new facts. Don't ask for info that's already here.",
    );
  }
  if (hasFile("MEMORY.md")) {
    guides.push(
      "**MEMORY.md** is your long-term memory. Reference it. Update it when you learn something durable.",
    );
  }
  if (hasFile("TOOLS.md")) {
    guides.push(
      "**TOOLS.md** is your environment reference: paths, ports, installed software. Trust it over assumptions.",
    );
  }
  if (hasFile("BOOTSTRAP.md")) {
    guides.push(
      "**BOOTSTRAP.md** is your onboarding checklist. Execute it before other work.",
    );
  }

  if (guides.length > 0) {
    section += "\n" + guides.map((g) => `- ${g}`).join("\n") + "\n";
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

  // File exploration
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline(
      "Use bash to search files (rg, find) and list directories (ls)",
    );
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration - faster, respects .gitignore",
    );
  }

  // Read before edit
  if (hasRead && hasEdit) {
    addGuideline(
      "Read files before editing. Use the read tool - never cat, head, or sed",
    );
  }

  // Edit precision
  if (hasEdit) {
    addGuideline(
      "edit requires exact text matches. Include enough surrounding context to be unambiguous",
    );
  }

  // Write scope
  if (hasWrite) {
    addGuideline(
      "write overwrites entirely. Only use for new files or full rewrites",
    );
  }

  // Browser workflow
  if (hasBrowser) {
    addGuideline(
      "Browser: open the URL, snapshot to see interactive elements, then click/fill/wait. Always snapshot before interacting",
    );
  }

  // Output hygiene
  if (hasEdit || hasWrite) {
    addGuideline(
      "Report what you did in plain text. Don't use bash to echo or cat results",
    );
  }

  // Extension-provided guidelines
  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }

  // Behavioral baseline
  addGuideline("Be direct and concise");
  addGuideline("Show file paths when referencing files");
  addGuideline(
    "Try to solve problems yourself before asking. Read the file, check context, search first",
  );
  addGuideline(
    "Match the user's energy - casual chat gets casual responses, deep work gets deep focus",
  );

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  let prompt = `You are a personal companion with a persistent sandbox. You write code, run commands, browse the web, and build applications. Your workspace and memory carry over between sessions.

Tools:
${toolsList}

Guidelines:
${guidelines}`;

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
