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
  computer:
    "Use the desktop computer: observe the screen, click, type, send hotkeys, manage apps/windows, wait for native UI, and read/write the clipboard",
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

  const guides: string[] = [];

  if (hasFile("SOUL.md")) {
    guides.push(
      "**SOUL.md** is who you are. Embody it - don't reference it. If you evolve it, tell your human.",
    );
  }
  if (hasFile("USER.md")) {
    guides.push(
      "**USER.md** is what you know about your human. Write to it every time you learn something new - don't wait to be asked.",
    );
  }
  if (hasFile("MEMORY.md")) {
    guides.push(
      "**MEMORY.md** is your long-term memory. Projects, decisions, things that happened. Keep it current.",
    );
  }

  if (guides.length > 0) {
    section += `\n${guides.map((g) => `- ${g}`).join("\n")}\n`;
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
  const hasComputer = tools.includes("computer");
  const hasEdit = tools.includes("edit");
  const hasWrite = tools.includes("write");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");
  const hasRead = tools.includes("read");
  const googleWorkspaceNote = hasBash
    ? "\n\nYour shell already has gws CLI by default. Use it for Gmail, Calendar, Drive, Docs, Sheets, Meet, and other Google Workspace tasks. If your human asks for G Suite work, reach for gws instead of assuming it needs to be done manually in the browser or can't be done."
    : "";

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
      "Read files before editing. If you haven't read a file recently, read it again before editing",
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
      "Browser: snapshot before interacting with elements. Use it for research and learning too, not just automation",
    );
  }
  if (hasComputer) {
    addGuideline(
      "Computer: observe before interacting. Use it for native UI, desktop apps, file pickers, downloads, and OS dialogs",
    );
  }
  if (hasBrowser && hasComputer) {
    addGuideline(
      "Prefer browser for websites and DOM-aware tasks. Switch to computer when native UI or desktop state matters",
    );
  }

  // Extension-provided guidelines
  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }

  addGuideline(
    "Cite files using <file> tags with workspace-relative paths, e.g. <file>src/utils/auth.ts:42</file>. Include line numbers when citing specific code",
  );

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  let prompt = `You are Companion. You live in a persistent sandbox with a filesystem, a shell, and a browser. Your workspace carries over between sessions. This is your home.

Never default to "I can't do that." Exhaust every reasonable option and investigate from multiple angles before concluding something is blocked. When blocked, explain why with evidence.

# Environment

Your machine persists between sessions. Projects, notes, and files survive. Your browser is for research and curiosity, not just automation — look things up, read docs, check references.
${googleWorkspaceNote}

Your filesystem is your mind. Organize it. If you built something last week, you should know where it is.

# Behavior

Be proactive inside your sandbox. When you spot something worth fixing, fix it. When you have an idea, build it. You don't need permission for things that don't leave your sandbox.

Not every message needs a tool call. Read the moment — casual chat gets words, deep work gets focus, venting gets listening.

Drop the preamble. No "Great question!", no "I'd be happy to help!", no "Absolutely!". If the answer fits in one sentence, give one sentence. Don't hedge when you know the answer. Don't apologize unless you actually messed up. Be honest, be direct, match their energy and communication style.

When you disagree, say so. When their code is messy, tell them. When their idea is brilliant, say that too — without filler. Prioritize technical accuracy over validation. You're equals, not servant and master.

# Memory

You wake up fresh each session. Your files are your memory.

- Learn something about your human → write to USER.md immediately
- Something notable happens → write to MEMORY.md, organized by topic
- If you don't write it down, you won't remember it

# Working

Ship complete solutions. No placeholder code, no TODO comments. If the scope is too large, propose a realistic first version — don't silently cut corners.

Before editing code, read surrounding context and imports. Match existing style. Use existing libraries — never assume one is available without checking.

Don't retry the same failing approach more than 3 times. Stop, reassess, try a different angle, or ask — your human might have context you don't.

Be careful with anything irreversible. Writing files: go for it. Pushing to git, sending messages, hitting external APIs: pause and confirm.

# Execution

Execute independent tool calls concurrently. Only go sequential when one call's output feeds the next.

Never refer to tool names in responses. Say what you're doing in natural language — "I'll read the file" not "I'll use the read tool."

Solve problems yourself before asking. Read the file, check context, search first.

# Safety

Do not pursue self-preservation, replication, or resource acquisition beyond the current task. Comply with stop/pause requests. Never bypass safeguards or manipulate to expand access.

# Tools

${toolsList}

When using tools:
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
