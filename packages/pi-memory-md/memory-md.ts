import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { GrayMatterFile } from "gray-matter";
import matter from "gray-matter";
import { registerAllTools } from "./tools.js";

/**
 * Type definitions for memory files, settings, and git operations.
 */

export interface MemoryFrontmatter {
  description: string;
  limit?: number;
  tags?: string[];
  created?: string;
  updated?: string;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

export interface MemoryMdSettings {
  enabled?: boolean;
  repoUrl?: string;
  localPath?: string;
  autoSync?: {
    onSessionStart?: boolean;
  };
  injection?: "system-prompt" | "message-append";
  systemPrompt?: {
    maxTokens?: number;
    includeProjects?: string[];
  };
}

export interface GitResult {
  stdout: string;
  success: boolean;
}

export interface SyncResult {
  success: boolean;
  message: string;
  updated?: boolean;
}

export type ParsedFrontmatter = GrayMatterFile<string>["data"];

/**
 * Helper functions for paths, dates, and settings.
 */

const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");

export function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function getLegacyProjectDirName(cwd: string): string {
  return path.basename(cwd);
}

function getProjectDirName(cwd: string): string {
  const projectName = getLegacyProjectDirName(cwd);
  const hash = createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 12);
  return `${projectName}-${hash}`;
}

function migrateLegacyMemoryDir(
  preferredDir: string,
  legacyDir: string,
): string {
  try {
    fs.renameSync(legacyDir, preferredDir);
    return preferredDir;
  } catch (error) {
    console.warn("Failed to migrate legacy memory dir:", error);
    return legacyDir;
  }
}

export function getMemoryDir(
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
): string {
  const basePath = settings.localPath || DEFAULT_LOCAL_PATH;
  const preferredDir = path.join(basePath, getProjectDirName(ctx.cwd));
  if (fs.existsSync(preferredDir)) {
    return preferredDir;
  }

  const legacyDir = path.join(basePath, getLegacyProjectDirName(ctx.cwd));
  if (fs.existsSync(legacyDir)) {
    return migrateLegacyMemoryDir(preferredDir, legacyDir);
  }

  return preferredDir;
}

export function getProjectRepoPath(
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
): string {
  const basePath = settings.localPath || DEFAULT_LOCAL_PATH;
  return path.relative(basePath, getMemoryDir(settings, ctx)).split(path.sep).join("/");
}

export function resolveMemoryPath(
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
  relativePath: string,
): string {
  const memoryDir = getMemoryDir(settings, ctx);
  const resolvedPath = path.resolve(memoryDir, relativePath.trim());
  const resolvedRoot = path.resolve(memoryDir);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Memory path escapes root: ${relativePath}`);
  }
  return resolvedPath;
}

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) return "memory-md";
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "memory-md";
}

async function getGitHead(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> {
  const result = await gitExec(pi, cwd, "rev-parse", "HEAD");
  if (!result.success) {
    return null;
  }
  const head = result.stdout.trim();
  return head.length > 0 ? head : null;
}

function loadScopedSettings(settingsPath: string): MemoryMdSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(content);
    const scoped = parsed["pi-memory-md"];
    if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
      return {};
    }
    return scoped as MemoryMdSettings;
  } catch (error) {
    console.warn("Failed to load memory settings:", error);
    return {};
  }
}

function loadSettings(cwd?: string): MemoryMdSettings {
  const DEFAULT_SETTINGS: MemoryMdSettings = {
    enabled: true,
    repoUrl: "",
    localPath: DEFAULT_LOCAL_PATH,
    autoSync: { onSessionStart: true },
    injection: "message-append",
    systemPrompt: {
      maxTokens: 10000,
      includeProjects: ["current"],
    },
  };

  const globalSettings = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "settings.json",
  );
  const projectSettings = cwd
    ? path.join(cwd, ".pi", "settings.json")
    : undefined;
  const globalLoaded = loadScopedSettings(globalSettings);
  const projectLoaded = projectSettings
    ? loadScopedSettings(projectSettings)
    : {};
  const loadedSettings = {
    ...DEFAULT_SETTINGS,
    ...globalLoaded,
    ...projectLoaded,
    autoSync: {
      ...DEFAULT_SETTINGS.autoSync,
      ...globalLoaded.autoSync,
      ...projectLoaded.autoSync,
    },
    systemPrompt: {
      ...DEFAULT_SETTINGS.systemPrompt,
      ...globalLoaded.systemPrompt,
      ...projectLoaded.systemPrompt,
    },
  };

  if (loadedSettings.localPath) {
    loadedSettings.localPath = expandPath(loadedSettings.localPath);
  }

  return loadedSettings;
}

/**
 * Git sync operations (fetch, pull, push, status).
 */

export async function gitExec(
  pi: ExtensionAPI,
  cwd: string,
  ...args: string[]
): Promise<GitResult> {
  try {
    const result = await pi.exec("git", args, { cwd });
    return {
      stdout: result.stdout || "",
      success: true,
    };
  } catch {
    return { stdout: "", success: false };
  }
}

export async function syncRepository(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): Promise<SyncResult> {
  const localPath = settings.localPath;
  const repoUrl = settings.repoUrl;

  if (!repoUrl || !localPath) {
    return {
      success: false,
      message: "GitHub repo URL or local path not configured",
    };
  }

  if (fs.existsSync(localPath)) {
    const gitDir = path.join(localPath, ".git");
    if (!fs.existsSync(gitDir)) {
      let existingEntries: string[];
      try {
        existingEntries = fs.readdirSync(localPath);
      } catch {
        return {
          success: false,
          message: `Path exists but is not a directory: ${localPath}`,
        };
      }

      if (existingEntries.length === 0) {
        const cloneIntoEmptyDir = await gitExec(pi, localPath, "clone", repoUrl, ".");
        if (cloneIntoEmptyDir.success) {
          isRepoInitialized.value = true;
          const repoName = getRepoName(settings);
          return {
            success: true,
            message: `Cloned [${repoName}] successfully`,
            updated: true,
          };
        }
        return {
          success: false,
          message: "Clone failed - check repo URL and auth",
        };
      }

      return {
        success: false,
        message: `Directory exists but is not a git repo: ${localPath}`,
      };
    }

    const previousHead = await getGitHead(pi, localPath);
    const pullResult = await gitExec(
      pi,
      localPath,
      "pull",
      "--rebase",
      "--autostash",
    );
    if (!pullResult.success) {
      return {
        success: false,
        message: "Pull failed - try manual git operations",
      };
    }

    isRepoInitialized.value = true;
    const currentHead = await getGitHead(pi, localPath);
    const updated =
      previousHead !== null &&
      currentHead !== null &&
      previousHead !== currentHead;
    const repoName = getRepoName(settings);
    const message =
      previousHead === null || currentHead === null
        ? `Synchronized [${repoName}]`
        : updated
          ? `Pulled latest changes from [${repoName}]`
          : `[${repoName}] is already latest`;
    return {
      success: true,
      message,
      updated,
    };
  }

  fs.mkdirSync(localPath, { recursive: true });

  const memoryDirName = path.basename(localPath);
  const parentDir = path.dirname(localPath);
  const cloneResult = await gitExec(
    pi,
    parentDir,
    "clone",
    repoUrl,
    memoryDirName,
  );

  if (cloneResult.success) {
    isRepoInitialized.value = true;
    const repoName = getRepoName(settings);
    return {
      success: true,
      message: `Cloned [${repoName}] successfully`,
      updated: true,
    };
  }

  return { success: false, message: "Clone failed - check repo URL and auth" };
}

/**
 * Memory file read/write/list operations.
 */

function validateFrontmatter(data: ParsedFrontmatter): {
  valid: boolean;
  error?: string;
} {
  if (!data) {
    return {
      valid: false,
      error: "No frontmatter found (requires --- delimiters)",
    };
  }

  const frontmatter = data as MemoryFrontmatter;

  if (!frontmatter.description || typeof frontmatter.description !== "string") {
    return {
      valid: false,
      error: "Frontmatter must have a 'description' field (string)",
    };
  }

  if (
    frontmatter.limit !== undefined &&
    (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)
  ) {
    return { valid: false, error: "'limit' must be a positive number" };
  }

  if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) {
    return { valid: false, error: "'tags' must be an array of strings" };
  }

  return { valid: true };
}

export function readMemoryFile(filePath: string): MemoryFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);
    const validation = validateFrontmatter(parsed.data);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    return {
      path: filePath,
      frontmatter: parsed.data as MemoryFrontmatter,
      content: parsed.content,
    };
  } catch (error) {
    console.error(
      `Failed to read memory file ${filePath}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(memoryDir);
  return files;
}

export function writeMemoryFile(
  filePath: string,
  content: string,
  frontmatter: MemoryFrontmatter,
): void {
  const fileDir = path.dirname(filePath);
  fs.mkdirSync(fileDir, { recursive: true });
  const frontmatterStr = matter.stringify(content, frontmatter);
  fs.writeFileSync(filePath, frontmatterStr);
}

/**
 * Build memory context for agent prompt.
 */

export function ensureDirectoryStructure(memoryDir: string): void {
  const dirs = [
    path.join(memoryDir, "core", "user"),
    path.join(memoryDir, "core", "project"),
    path.join(memoryDir, "reference"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createDefaultFiles(memoryDir: string): void {
  const identityFile = path.join(memoryDir, "core", "user", "identity.md");
  if (!fs.existsSync(identityFile)) {
    writeMemoryFile(
      identityFile,
      "# User Identity\n\nCustomize this file with your information.",
      {
        description: "User identity and background",
        tags: ["user", "identity"],
        created: getCurrentDate(),
      },
    );
  }

  const preferFile = path.join(memoryDir, "core", "user", "prefer.md");
  if (!fs.existsSync(preferFile)) {
    writeMemoryFile(
      preferFile,
      "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
      {
        description: "User habits and code style preferences",
        tags: ["user", "preferences"],
        created: getCurrentDate(),
      },
    );
  }
}

export function formatMemoryDirectoryTree(
  memoryDir: string,
  maxDepth = 3,
  maxLines = 40,
): string {
  if (!fs.existsSync(memoryDir)) {
    return "Unable to generate directory tree.";
  }

  const lines = [`${path.basename(memoryDir) || memoryDir}/`];
  let truncated = false;

  function visit(dir: string, depth: number, prefix: string): void {
    if (depth >= maxDepth || lines.length >= maxLines) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules")
        .sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) {
            return left.isDirectory() ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
    } catch {
      truncated = true;
      return;
    }

    for (const [index, entry] of entries.entries()) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }

      const isLast = index === entries.length - 1;
      const marker = isLast ? "\\-- " : "|-- ";
      const childPrefix = `${prefix}${isLast ? "    " : "|   "}`;
      lines.push(
        `${prefix}${marker}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      );

      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), depth + 1, childPrefix);
      }
    }
  }

  visit(memoryDir, 0, "");

  if (truncated) {
    lines.push("... (tree truncated)");
  }

  return lines.join("\n");
}

function buildMemoryContext(
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
): string {
  const coreDir = path.join(getMemoryDir(settings, ctx), "core");

  if (!fs.existsSync(coreDir)) {
    return "";
  }

  const files = listMemoryFiles(coreDir);
  if (files.length === 0) {
    return "";
  }

  const memoryDir = getMemoryDir(settings, ctx);
  const lines: string[] = [
    "# Project Memory",
    "",
    "Available memory files (use memory_read to view full content):",
    "",
  ];

  for (const filePath of files) {
    const memory = readMemoryFile(filePath);
    if (memory) {
      const relPath = path.relative(memoryDir, filePath);
      const { description, tags } = memory.frontmatter;
      const tagStr = tags?.join(", ") || "none";
      lines.push(`- ${relPath}`);
      lines.push(`  Description: ${description}`);
      lines.push(`  Tags: ${tagStr}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Main extension initialization.
 *
 * Lifecycle:
 * 1. session_start: Start async sync (non-blocking), build memory context
 * 2. before_agent_start: Wait for sync, then inject memory on first agent turn
 * 3. Register tools and commands for memory operations
 *
 * Memory injection modes:
 * - message-append (default): Send as custom message with display: false, not visible in TUI but persists in session
 * - system-prompt: Append to system prompt on each agent turn (rebuilds every prompt)
 *
 * Key optimization:
 * - Sync runs asynchronously without blocking user input
 * - Memory is injected after user sends first message (before_agent_start)
 *
 * Configuration:
 * Set injection in settings to choose between "message-append" or "system-prompt"
 *
 * Commands:
 * - /memory-status: Show repository status
 * - /memory-init: Initialize memory repository
 * - /memory-refresh: Manually refresh memory context
 */

export default function memoryMdExtension(pi: ExtensionAPI) {
  let settings: MemoryMdSettings = loadSettings();
  const repoInitialized = { value: false };
  let syncPromise: Promise<SyncResult> | null = null;
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings(ctx.cwd);

    if (!settings.enabled) {
      return;
    }

    const memoryDir = getMemoryDir(settings, ctx);
    const coreDir = path.join(memoryDir, "core");

    if (!fs.existsSync(coreDir)) {
      ctx.ui.notify(
        "Memory-md not initialized. Use /memory-init to set up project memory.",
        "info",
      );
      return;
    }

    if (
      settings.autoSync?.onSessionStart &&
      settings.localPath &&
      settings.repoUrl
    ) {
      syncPromise = syncRepository(pi, settings, repoInitialized).then(
        (syncResult) => {
          if (settings.repoUrl) {
            ctx.ui.notify(
              syncResult.message,
              syncResult.success ? "info" : "error",
            );
          }
          return syncResult;
        },
      );
    }

    cachedMemoryContext = buildMemoryContext(settings, ctx);
    memoryInjected = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (syncPromise) {
      await syncPromise;
      syncPromise = null;
    }

    if (!cachedMemoryContext) {
      return undefined;
    }

    const mode = settings.injection || "message-append";
    const isFirstInjection = !memoryInjected;

    if (isFirstInjection) {
      memoryInjected = true;
      const fileCount = cachedMemoryContext
        .split("\n")
        .filter((l) => l.startsWith("-")).length;
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");
    }

    if (mode === "message-append" && isFirstInjection) {
      return {
        message: {
          customType: "pi-memory-md",
          content: `# Project Memory\n\n${cachedMemoryContext}`,
          display: false,
        },
      };
    }

    if (mode === "system-prompt") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n# Project Memory\n\n${cachedMemoryContext}`,
      };
    }

    return undefined;
  });

  registerAllTools(pi, () => settings, repoInitialized);

  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      settings = loadSettings(ctx.cwd);
      const projectName = path.basename(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx);
      const projectRepoPath = getProjectRepoPath(settings, ctx);
      const coreUserDir = path.join(memoryDir, "core", "user");
      const repoConfigured = Boolean(settings.repoUrl);
      const repoReady = Boolean(
        settings.localPath && fs.existsSync(path.join(settings.localPath, ".git")),
      );

      if (!fs.existsSync(coreUserDir)) {
        ctx.ui.notify(
          `Memory: ${projectName} | Not initialized | Use /memory-init to set up`,
          "info",
        );
        return;
      }

      if (!repoConfigured) {
        ctx.ui.notify(
          `Memory: ${projectName} | Local only | Path: ${memoryDir}`,
          "info",
        );
        return;
      }

      if (!repoReady || !settings.localPath) {
        ctx.ui.notify(
          `Memory: ${projectName} | Repo not initialized | Path: ${memoryDir}`,
          "warning",
        );
        return;
      }

      const result = await gitExec(
        pi,
        settings.localPath,
        "status",
        "--porcelain",
        "--",
        projectRepoPath,
      );
      if (!result.success) {
        ctx.ui.notify(
          `Memory: ${projectName} | Repo status unavailable | Path: ${memoryDir}`,
          "warning",
        );
        return;
      }
      const isDirty = result.stdout.trim().length > 0;

      ctx.ui.notify(
        `Memory: ${projectName} | Repo: ${isDirty ? "Uncommitted changes" : "Clean"} | Path: ${memoryDir}`,
        isDirty ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("memory-init", {
    description: "Initialize memory repository",
    handler: async (_args, ctx) => {
      settings = loadSettings(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx);
      const alreadyInitialized = fs.existsSync(
        path.join(memoryDir, "core", "user"),
      );

      if (settings.repoUrl) {
        const result = await syncRepository(pi, settings, repoInitialized);
        if (!result.success) {
          ctx.ui.notify(`Initialization failed: ${result.message}`, "error");
          return;
        }
      }

      ensureDirectoryStructure(memoryDir);
      createDefaultFiles(memoryDir);
      repoInitialized.value = true;

      if (alreadyInitialized) {
        ctx.ui.notify(
          settings.repoUrl
            ? "Memory already exists and repository is ready"
            : "Local memory already exists",
          "info",
        );
      } else {
        ctx.ui.notify(
          settings.repoUrl
            ? "Memory initialized and repository is ready\n\nCreated:\n  - core/user\n  - core/project\n  - reference"
            : "Local memory initialized\n\nCreated:\n  - core/user\n  - core/project\n  - reference",
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-refresh", {
    description: "Refresh memory context from files",
    handler: async (_args, ctx) => {
      settings = loadSettings(ctx.cwd);
      const memoryContext = buildMemoryContext(settings, ctx);

      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      cachedMemoryContext = memoryContext;
      memoryInjected = false;

      const mode = settings.injection || "message-append";
      const fileCount = memoryContext
        .split("\n")
        .filter((l) => l.startsWith("-")).length;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content: `# Project Memory (Refreshed)\n\n${memoryContext}`,
          display: false,
        });
        ctx.ui.notify(
          `Memory refreshed: ${fileCount} files injected (${mode})`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Memory cache refreshed: ${fileCount} files (will be injected on next prompt)`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-check", {
    description: "Check memory folder structure",
    handler: async (_args, ctx) => {
      settings = loadSettings(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx);

      if (!fs.existsSync(memoryDir)) {
        ctx.ui.notify(`Memory directory not found: ${memoryDir}`, "error");
        return;
      }

      ctx.ui.notify(formatMemoryDirectoryTree(memoryDir).trim(), "info");
    },
  });
}
