import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execCommand } from "../exec.js";
import type { SettingsManager } from "../settings-manager.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { HttpError } from "./internal-types.js";

export interface MemoryFrontmatter {
  description: string;
  limit?: number;
  tags?: string[];
  created?: string;
  updated?: string;
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

export interface MemoryStatus {
  enabled: boolean;
  cwd: string;
  project: string;
  directory: string;
  localPath: string;
  repoUrl: string | null;
  repoConfigured: boolean;
  repositoryReady: boolean;
  initialized: boolean;
  dirty: boolean | null;
  fileCount: number;
}

export interface MemoryFileSummary {
  path: string;
  description: string | null;
  tags: string[];
  created?: string;
  updated?: string;
  valid: boolean;
}

export interface MemoryFileRecord {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

export interface MemorySearchResult {
  path: string;
  match: string;
  description: string;
  tags: string[];
}

export interface MemorySyncResult {
  success: boolean;
  message: string;
  configured: boolean;
  initialized: boolean;
  dirty: boolean | null;
  updated?: boolean;
  committed?: boolean;
}

export type MemorySearchScope = "content" | "tags" | "description";
export type MemorySyncAction = "pull" | "push" | "status";

const DEFAULT_LOCAL_PATH = join(homedir(), ".pi", "memory-md");
const DEFAULT_MEMORY_SETTINGS: MemoryMdSettings = {
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

function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

function getLegacyProjectDirName(cwd: string): string {
  return basename(cwd);
}

function getProjectDirName(cwd: string): string {
  const projectName = getLegacyProjectDirName(cwd);
  const hash = createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 12);
  return `${projectName}-${hash}`;
}

function getMemoryDirCandidates(
  settings: MemoryMdSettings,
  cwd: string,
): {
  preferred: string;
  legacy: string;
} {
  const basePath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  return {
    preferred: join(basePath, getProjectDirName(cwd)),
    legacy: join(basePath, getLegacyProjectDirName(cwd)),
  };
}

function migrateLegacyMemoryDir(preferred: string, legacy: string): string {
  try {
    renameSync(legacy, preferred);
    return preferred;
  } catch {
    return legacy;
  }
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function expandPath(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  return join(homedir(), value.slice(1));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readScopedMemorySettings(
  settings: Record<string, unknown>,
): MemoryMdSettings {
  const scoped = asRecord(settings["pi-memory-md"]);
  return scoped ? (scoped as MemoryMdSettings) : {};
}

function getMemorySettings(settingsManager: SettingsManager): MemoryMdSettings {
  const globalSettings = readScopedMemorySettings(
    settingsManager.getGlobalSettings() as Record<string, unknown>,
  );
  const projectSettings = readScopedMemorySettings(
    settingsManager.getProjectSettings() as Record<string, unknown>,
  );
  const merged: MemoryMdSettings = {
    ...DEFAULT_MEMORY_SETTINGS,
    ...globalSettings,
    ...projectSettings,
    autoSync: {
      ...DEFAULT_MEMORY_SETTINGS.autoSync,
      ...globalSettings.autoSync,
      ...projectSettings.autoSync,
    },
    systemPrompt: {
      ...DEFAULT_MEMORY_SETTINGS.systemPrompt,
      ...globalSettings.systemPrompt,
      ...projectSettings.systemPrompt,
    },
  };
  if (merged.localPath) {
    merged.localPath = expandPath(merged.localPath);
  }
  return merged;
}

function getMemoryDir(settings: MemoryMdSettings, cwd: string): string {
  const { preferred, legacy } = getMemoryDirCandidates(settings, cwd);
  if (existsSync(preferred)) {
    return preferred;
  }
  if (existsSync(legacy)) {
    return migrateLegacyMemoryDir(preferred, legacy);
  }
  return preferred;
}

function getProjectRepoPath(settings: MemoryMdSettings, cwd: string): string {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  return normalizePathSeparators(relative(localPath, getMemoryDir(settings, cwd)));
}

function validateFrontmatter(frontmatter: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  if (
    typeof frontmatter.description !== "string" ||
    frontmatter.description.trim().length === 0
  ) {
    return {
      valid: false,
      error: "Frontmatter must contain a non-empty description",
    };
  }
  if (
    frontmatter.limit !== undefined &&
    (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)
  ) {
    return {
      valid: false,
      error: "Frontmatter limit must be a positive number",
    };
  }
  if (frontmatter.tags !== undefined) {
    if (!Array.isArray(frontmatter.tags)) {
      return {
        valid: false,
        error: "Frontmatter tags must be an array of strings",
      };
    }
    if (
      frontmatter.tags.some((tag) => typeof tag !== "string" || tag.length === 0)
    ) {
      return {
        valid: false,
        error: "Frontmatter tags must contain only non-empty strings",
      };
    }
  }
  return { valid: true };
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>): MemoryFrontmatter {
  return {
    description: frontmatter.description as string,
    ...(typeof frontmatter.limit === "number"
      ? { limit: frontmatter.limit }
      : {}),
    ...(Array.isArray(frontmatter.tags)
      ? {
          tags: frontmatter.tags.filter(
            (tag): tag is string => typeof tag === "string",
          ),
        }
      : {}),
    ...(typeof frontmatter.created === "string"
      ? { created: frontmatter.created }
      : {}),
    ...(typeof frontmatter.updated === "string"
      ? { updated: frontmatter.updated }
      : {}),
  };
}

function readMemoryFile(filePath: string): MemoryFileRecord | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    const validation = validateFrontmatter(parsed.frontmatter);
    if (!validation.valid) {
      return null;
    }
    return {
      path: filePath,
      frontmatter: normalizeFrontmatter(parsed.frontmatter),
      content: parsed.body,
    };
  } catch {
    return null;
  }
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}

function serializeFrontmatter(frontmatter: MemoryFrontmatter): string {
  const lines = ["---", `description: ${escapeYamlString(frontmatter.description)}`];
  if (typeof frontmatter.limit === "number") {
    lines.push(`limit: ${frontmatter.limit}`);
  }
  if (frontmatter.tags && frontmatter.tags.length > 0) {
    lines.push("tags:");
    for (const tag of frontmatter.tags) {
      lines.push(`  - ${escapeYamlString(tag)}`);
    }
  }
  if (frontmatter.created) {
    lines.push(`created: ${escapeYamlString(frontmatter.created)}`);
  }
  if (frontmatter.updated) {
    lines.push(`updated: ${escapeYamlString(frontmatter.updated)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function writeMemoryFile(
  filePath: string,
  content: string,
  frontmatter: MemoryFrontmatter,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const body = normalizedContent.endsWith("\n")
    ? normalizedContent
    : `${normalizedContent}\n`;
  const output = `${serializeFrontmatter(frontmatter)}\n\n${body}`;
  writeFileSync(filePath, output, "utf8");
}

function listMemoryFiles(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) {
    return [];
  }
  const files: string[] = [];
  const stack = [memoryDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function ensureDirectoryStructure(memoryDir: string): void {
  const directories = [
    join(memoryDir, "core", "user"),
    join(memoryDir, "core", "project"),
    join(memoryDir, "reference"),
  ];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
}

function ensureDefaultFiles(memoryDir: string): void {
  const identityPath = join(memoryDir, "core", "user", "identity.md");
  if (!existsSync(identityPath)) {
    writeMemoryFile(
      identityPath,
      "# User Identity\n\nCustomize this file with your information.",
      {
        description: "User identity and background",
        tags: ["user", "identity"],
        created: getCurrentDate(),
      },
    );
  }

  const preferencesPath = join(memoryDir, "core", "user", "prefer.md");
  if (!existsSync(preferencesPath)) {
    writeMemoryFile(
      preferencesPath,
      "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
      {
        description: "User habits and code style preferences",
        tags: ["user", "preferences"],
        created: getCurrentDate(),
      },
    );
  }
}

function resolveWithinMemoryDir(memoryDir: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "Memory path is required");
  }
  const resolvedPath = resolve(memoryDir, trimmed);
  const resolvedRoot = resolve(memoryDir);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new HttpError(400, `Memory path escapes root: ${relativePath}`);
  }
  return resolvedPath;
}

function summarizeMemoryFile(
  memoryDir: string,
  filePath: string,
): MemoryFileSummary {
  const relativePath = normalizePathSeparators(relative(memoryDir, filePath));
  const memoryFile = readMemoryFile(filePath);
  if (!memoryFile) {
    return {
      path: relativePath,
      description: null,
      tags: [],
      valid: false,
    };
  }
  return {
    path: relativePath,
    description: memoryFile.frontmatter.description,
    tags: memoryFile.frontmatter.tags ?? [],
    created: memoryFile.frontmatter.created,
    updated: memoryFile.frontmatter.updated,
    valid: true,
  };
}

function readMemoryFileOrThrow(
  memoryDir: string,
  relativePath: string,
): MemoryFileRecord {
  const fullPath = resolveWithinMemoryDir(memoryDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new HttpError(404, `Memory file not found: ${relativePath}`);
  }
  const memoryFile = readMemoryFile(fullPath);
  if (!memoryFile) {
    throw new HttpError(422, `Invalid memory file: ${relativePath}`);
  }
  return {
    ...memoryFile,
    path: normalizePathSeparators(relative(memoryDir, fullPath)),
  };
}

async function runGit(
  cwd: string,
  ...args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const result = await execCommand("git", args, cwd, { timeout: 30_000 });
  return {
    success: result.code === 0 && !result.killed,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) {
    return "memory-md";
  }
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match?.[1] ?? "memory-md";
}

async function getGitHead(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, "rev-parse", "HEAD");
  if (!result.success) {
    return null;
  }
  const head = result.stdout.trim();
  return head.length > 0 ? head : null;
}

async function getRepositoryDirtyState(
  localPath: string,
  projectPath?: string,
): Promise<boolean | null> {
  if (!existsSync(join(localPath, ".git"))) {
    return null;
  }
  const args = projectPath
    ? ["status", "--porcelain", "--", projectPath]
    : ["status", "--porcelain"];
  const result = await runGit(localPath, ...args);
  if (!result.success) {
    return null;
  }
  return result.stdout.trim().length > 0;
}

async function syncRepository(
  settings: MemoryMdSettings,
): Promise<{ success: boolean; message: string; updated?: boolean }> {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const repoUrl = settings.repoUrl?.trim() ?? "";

  if (!repoUrl) {
    return {
      success: false,
      message: "Memory repo URL is not configured",
    };
  }

  if (existsSync(localPath)) {
    if (!existsSync(join(localPath, ".git"))) {
      let existingEntries: string[];
      try {
        existingEntries = readdirSync(localPath);
      } catch {
        return {
          success: false,
          message: `Path exists but is not a directory: ${localPath}`,
        };
      }
      if (existingEntries.length === 0) {
        const cloneIntoEmptyDir = await runGit(localPath, "clone", repoUrl, ".");
        if (!cloneIntoEmptyDir.success) {
          return {
            success: false,
            message:
              cloneIntoEmptyDir.stderr.trim() ||
              "Clone failed. Check repo URL and auth.",
          };
        }
        return {
          success: true,
          message: `Cloned ${getRepoName(settings)} successfully`,
          updated: true,
        };
      }
      return {
        success: false,
        message: `Directory exists but is not a git repo: ${localPath}`,
      };
    }
    const previousHead = await getGitHead(localPath);
    const pullResult = await runGit(localPath, "pull", "--rebase", "--autostash");
    if (!pullResult.success) {
      return {
        success: false,
        message:
          pullResult.stderr.trim() || "Pull failed. Check repository state.",
      };
    }
    const currentHead = await getGitHead(localPath);
    const updated =
      previousHead !== null &&
      currentHead !== null &&
      previousHead !== currentHead;
    const message =
      previousHead === null || currentHead === null
        ? `Synchronized ${getRepoName(settings)}`
        : updated
          ? `Pulled latest changes from ${getRepoName(settings)}`
          : `${getRepoName(settings)} is already up to date`;
    return {
      success: true,
      message,
      updated,
    };
  }

  mkdirSync(dirname(localPath), { recursive: true });
  const cloneResult = await runGit(
    dirname(localPath),
    "clone",
    repoUrl,
    basename(localPath),
  );
  if (!cloneResult.success) {
    return {
      success: false,
      message: cloneResult.stderr.trim() || "Clone failed. Check repo URL and auth.",
    };
  }
  return {
    success: true,
    message: `Cloned ${getRepoName(settings)} successfully`,
    updated: true,
  };
}

export async function getMemoryStatus(
  settingsManager: SettingsManager,
  cwd: string,
): Promise<MemoryStatus> {
  const settings = getMemorySettings(settingsManager);
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const memoryDir = getMemoryDir(settings, cwd);
  const initialized = existsSync(join(memoryDir, "core", "user"));
  const fileCount = listMemoryFiles(memoryDir).length;
  const dirty = await getRepositoryDirtyState(
    localPath,
    getProjectRepoPath(settings, cwd),
  );
  return {
    enabled: settings.enabled ?? true,
    cwd,
    project: basename(cwd),
    directory: memoryDir,
    localPath,
    repoUrl: settings.repoUrl?.trim() || null,
    repoConfigured: Boolean(settings.repoUrl?.trim()),
    repositoryReady: existsSync(join(localPath, ".git")),
    initialized,
    dirty,
    fileCount,
  };
}

export async function initializeMemory(
  settingsManager: SettingsManager,
  cwd: string,
  options: { force?: boolean } = {},
): Promise<{
  ok: true;
  created: boolean;
  message: string;
  memory: MemoryStatus;
}> {
  const settings = getMemorySettings(settingsManager);
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const memoryDir = getMemoryDir(settings, cwd);
  const initialized = existsSync(join(memoryDir, "core", "user"));

  if (settings.repoUrl?.trim()) {
    const repositoryReady = existsSync(join(localPath, ".git"));
    if (!initialized || options.force || !repositoryReady) {
      const syncResult = await syncRepository(settings);
      if (!syncResult.success) {
        throw new HttpError(409, syncResult.message);
      }
    }
  } else {
    mkdirSync(localPath, { recursive: true });
  }

  ensureDirectoryStructure(memoryDir);
  ensureDefaultFiles(memoryDir);

  return {
    ok: true,
    created: !initialized,
    message:
      settings.repoUrl?.trim()
        ? initialized
          ? "Memory repository refreshed and project memory verified"
          : "Memory repository initialized for this project"
        : initialized
          ? "Local memory verified"
          : "Local memory initialized",
    memory: await getMemoryStatus(settingsManager, cwd),
  };
}

export async function listProjectMemoryFiles(
  settingsManager: SettingsManager,
  cwd: string,
  directory?: string,
): Promise<{
  directory: string;
  files: MemoryFileSummary[];
}> {
  const settings = getMemorySettings(settingsManager);
  const memoryDir = getMemoryDir(settings, cwd);
  const searchDir = directory
    ? resolveWithinMemoryDir(memoryDir, directory)
    : memoryDir;
  const files = listMemoryFiles(searchDir).map((filePath) =>
    summarizeMemoryFile(memoryDir, filePath),
  );
  return {
    directory: directory?.trim() || "",
    files,
  };
}

export async function readProjectMemoryFile(
  settingsManager: SettingsManager,
  cwd: string,
  relativePath: string,
): Promise<{ file: MemoryFileRecord }> {
  const settings = getMemorySettings(settingsManager);
  const memoryDir = getMemoryDir(settings, cwd);
  return {
    file: readMemoryFileOrThrow(memoryDir, relativePath),
  };
}

export async function writeProjectMemoryFile(
  settingsManager: SettingsManager,
  cwd: string,
  params: {
    path: string;
    content: string;
    description: string;
    tags?: string[];
  },
): Promise<{ ok: true; file: MemoryFileRecord }> {
  const relativePath = params.path.trim();
  if (!relativePath.endsWith(".md")) {
    throw new HttpError(400, "Memory files must use the .md extension");
  }
  if (params.description.trim().length === 0) {
    throw new HttpError(400, "Memory description is required");
  }

  const settings = getMemorySettings(settingsManager);
  const memoryDir = getMemoryDir(settings, cwd);
  const fullPath = resolveWithinMemoryDir(memoryDir, relativePath);
  if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
    throw new HttpError(400, `Memory path points to a directory: ${relativePath}`);
  }
  const existing = existsSync(fullPath) ? readMemoryFile(fullPath) : null;

  const hasTagsInput = params.tags !== undefined;
  const tags = (params.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const frontmatter: MemoryFrontmatter = {
    description: params.description.trim(),
    created: existing?.frontmatter.created ?? getCurrentDate(),
    updated: getCurrentDate(),
    ...(existing?.frontmatter.limit !== undefined
      ? { limit: existing.frontmatter.limit }
      : {}),
    ...(hasTagsInput
      ? { tags }
      : existing?.frontmatter.tags
        ? { tags: existing.frontmatter.tags }
        : {}),
  };

  writeMemoryFile(fullPath, params.content, frontmatter);

  return {
    ok: true,
    file: {
      path: normalizePathSeparators(relative(memoryDir, fullPath)),
      frontmatter,
      content: params.content.replace(/\r\n/g, "\n"),
    },
  };
}

export async function searchProjectMemory(
  settingsManager: SettingsManager,
  cwd: string,
  query: string,
  searchIn: MemorySearchScope,
): Promise<{ results: MemorySearchResult[] }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    throw new HttpError(400, "Memory search query is required");
  }

  const settings = getMemorySettings(settingsManager);
  const memoryDir = getMemoryDir(settings, cwd);
  const results: MemorySearchResult[] = [];

  for (const filePath of listMemoryFiles(memoryDir)) {
    const memoryFile = readMemoryFile(filePath);
    if (!memoryFile) {
      continue;
    }
    const relativePath = normalizePathSeparators(relative(memoryDir, filePath));
    if (searchIn === "content") {
      if (!memoryFile.content.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const match =
        memoryFile.content
          .split("\n")
          .find((line) => line.toLowerCase().includes(normalizedQuery)) ??
        memoryFile.content.slice(0, 120);
      results.push({
        path: relativePath,
        match,
        description: memoryFile.frontmatter.description,
        tags: memoryFile.frontmatter.tags ?? [],
      });
      continue;
    }

    if (searchIn === "tags") {
      const tags = memoryFile.frontmatter.tags ?? [];
      if (!tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))) {
        continue;
      }
      results.push({
        path: relativePath,
        match: `Tags: ${tags.join(", ")}`,
        description: memoryFile.frontmatter.description,
        tags,
      });
      continue;
    }

    if (
      memoryFile.frontmatter.description.toLowerCase().includes(normalizedQuery)
    ) {
      results.push({
        path: relativePath,
        match: memoryFile.frontmatter.description,
        description: memoryFile.frontmatter.description,
        tags: memoryFile.frontmatter.tags ?? [],
      });
    }
  }

  return { results };
}

export async function syncProjectMemory(
  settingsManager: SettingsManager,
  cwd: string,
  action: MemorySyncAction,
): Promise<MemorySyncResult> {
  const settings = getMemorySettings(settingsManager);
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const projectPath = getProjectRepoPath(settings, cwd);
  const configured = Boolean(settings.repoUrl?.trim());
  const repositoryReady = existsSync(join(localPath, ".git"));
  const initialized = existsSync(join(getMemoryDir(settings, cwd), "core", "user"));

  if (action === "status") {
    const dirty = await getRepositoryDirtyState(localPath, projectPath);
    return {
      success: repositoryReady,
      message: repositoryReady
        ? dirty
          ? "Memory repository has uncommitted changes"
          : "Memory repository is clean"
        : configured
          ? "Memory repository is not initialized"
          : "Memory repository is not configured",
      configured,
      initialized,
      dirty,
    };
  }

  if (!configured) {
    return {
      success: false,
      message: "Memory repo URL is not configured",
      configured,
      initialized,
      dirty: null,
    };
  }

  if (action === "pull") {
    const result = await syncRepository(settings);
    return {
      success: result.success,
      message: result.message,
      configured,
      initialized,
      dirty: await getRepositoryDirtyState(localPath, projectPath),
      updated: result.updated,
    };
  }

  const syncResult = await syncRepository(settings);
  if (!syncResult.success) {
    return {
      success: false,
      message: syncResult.message,
      configured,
      initialized,
      dirty: null,
      updated: syncResult.updated,
    };
  }

  const statusResult = await runGit(
    localPath,
    "status",
    "--porcelain",
    "--",
    projectPath,
  );
  if (!statusResult.success) {
    return {
      success: false,
      message: statusResult.stderr.trim() || "Failed to inspect memory repository",
      configured,
      initialized,
      dirty: null,
    };
  }

  const hasChanges = statusResult.stdout.trim().length > 0;
  if (hasChanges) {
    const addResult = await runGit(localPath, "add", "-A", "--", projectPath);
    if (!addResult.success) {
      return {
        success: false,
        message: addResult.stderr.trim() || "Failed to stage memory changes",
        configured,
        initialized,
        dirty: true,
      };
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const commitResult = await runGit(
      localPath,
      "commit",
      "-m",
      `Update memory for ${basename(cwd)} - ${timestamp}`,
      "--only",
      "--",
      projectPath,
    );
    if (!commitResult.success) {
      return {
        success: false,
        message:
          commitResult.stderr.trim() || "Failed to commit memory changes",
        configured,
        initialized,
        dirty: true,
      };
    }
  }

  const pushResult = await runGit(localPath, "push");
  return {
    success: pushResult.success,
    message: pushResult.success
      ? hasChanges
        ? "Committed and pushed memory changes"
        : "No memory changes to push"
      : pushResult.stderr.trim() || "Failed to push memory changes",
    configured,
    initialized,
    dirty: await getRepositoryDirtyState(localPath, projectPath),
    committed: hasChanges,
    updated: syncResult.updated,
  };
}
