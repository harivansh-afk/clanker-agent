import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  completeSimple,
  type Model,
  type TextContent,
} from "@mariozechner/pi-ai";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type { SettingsManager } from "../settings-manager.js";
import type { ReadonlySessionManager } from "../session-manager.js";

const DEFAULT_STORAGE_DIR = join(homedir(), ".pi", "memory");
const MAX_EPISODE_CHARS = 4_000;
const MAX_EPISODES = 5_000;
const DEFAULT_CORE_TOKEN_BUDGET = 700;
const DEFAULT_RECALL_RESULTS = 4;
const DEFAULT_WRITER_MAX_TOKENS = 600;
const CUSTOM_MEMORY_TYPE = "companion_memory";

const MEMORY_WRITER_SYSTEM_PROMPT = `You manage long-term conversational memory for a companion agent.

Decide which facts from the latest exchange should be persisted for future chats.

Rules:
- Save only information grounded in the user or assistant messages.
- Prefer durable facts, explicit remember requests, stable preferences, relationship context, and secrets/keys/codes the user will expect the companion to recall later.
- Use bucket "core" only for stable profile, preference, or relationship memory.
- Use bucket "archival" for facts and secrets that should be searchable later.
- Never invent details or infer beyond the exchange.
- If nothing should be saved, return {"memories":[]}.

Return strict JSON with this shape:
{"memories":[{"bucket":"core"|"archival","kind":"profile"|"preference"|"relationship"|"fact"|"secret","key":"stable-memory-slot","content":"memory text"}]}`;

export type RuntimeMemoryBucket = "core" | "archival";
export type RuntimeMemoryKind =
  | "profile"
  | "preference"
  | "relationship"
  | "fact"
  | "secret";
export type RuntimeMemorySource = "auto" | "manual" | "legacy-import";

export interface CompanionMemorySettings {
  enabled?: boolean;
  storageDir?: string;
  maxCoreTokens?: number;
  maxRecallResults?: number;
  writer?: {
    enabled?: boolean;
    maxTokens?: number;
  };
}

export interface RuntimeMemoryIdentity {
  key: string;
  scope: "agent" | "companion" | "sandbox" | "unknown";
}

export interface RuntimeMemoryStatus {
  enabled: boolean;
  ready: boolean;
  identity: RuntimeMemoryIdentity | null;
  storagePath: string | null;
  coreCount: number;
  archivalCount: number;
  episodeCount: number;
  lastMemoryWriteAt: number | null;
  lastEpisodeAt: number | null;
  legacyImportComplete: boolean;
}

export interface RuntimeMemoryRecord {
  id: number;
  bucket: RuntimeMemoryBucket;
  kind: RuntimeMemoryKind;
  key: string;
  content: string;
  source: RuntimeMemorySource;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
}

export interface RuntimeMemoryRememberInput {
  bucket?: RuntimeMemoryBucket;
  kind?: RuntimeMemoryKind;
  key?: string;
  content: string;
  source?: RuntimeMemorySource;
}

export interface RuntimeMemoryForgetInput {
  id?: number;
  key?: string;
}

export interface RuntimeMemorySearchResultItem {
  id: number;
  sourceType: "memory" | "episode";
  score: number;
  kind?: RuntimeMemoryKind;
  bucket?: RuntimeMemoryBucket;
  key?: string;
  content: string;
  role?: "user" | "assistant";
  timestamp: number;
  source?: RuntimeMemorySource;
}

export interface RuntimeMemorySearchResult {
  query: string;
  results: RuntimeMemorySearchResultItem[];
}

export interface RuntimeMemoryRebuildResult {
  ok: true;
  memoryRows: number;
  episodeRows: number;
}

interface MemoryRow {
  id: number;
  bucket: RuntimeMemoryBucket;
  kind: RuntimeMemoryKind;
  memory_key: string;
  content: string;
  source: RuntimeMemorySource;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  search_text: string;
}

interface EpisodeRow {
  id: number;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  search_text: string;
}

interface MemoryWriterResponse {
  memories?: Array<{
    bucket?: unknown;
    kind?: unknown;
    key?: unknown;
    content?: unknown;
  }>;
}

interface LegacyMemoryFile {
  path: string;
  body: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function expandHomePath(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  return join(homedir(), value.slice(1));
}

function getCompanionMemorySettings(
  settingsManager: SettingsManager,
): Required<CompanionMemorySettings> & {
  writer: { enabled: boolean; maxTokens: number };
} {
  const globalSettings = asRecord(settingsManager.getGlobalSettings()) ?? {};
  const projectSettings = asRecord(settingsManager.getProjectSettings()) ?? {};
  const globalMemory = asRecord(globalSettings.companionMemory) ?? {};
  const projectMemory = asRecord(projectSettings.companionMemory) ?? {};

  const enabled =
    typeof projectMemory.enabled === "boolean"
      ? projectMemory.enabled
      : typeof globalMemory.enabled === "boolean"
        ? globalMemory.enabled
        : true;
  const storageDir =
    asString(projectMemory.storageDir) ??
    asString(globalMemory.storageDir) ??
    DEFAULT_STORAGE_DIR;
  const maxCoreTokens =
    (typeof projectMemory.maxCoreTokens === "number"
      ? projectMemory.maxCoreTokens
      : typeof globalMemory.maxCoreTokens === "number"
        ? globalMemory.maxCoreTokens
        : DEFAULT_CORE_TOKEN_BUDGET) || DEFAULT_CORE_TOKEN_BUDGET;
  const maxRecallResults =
    (typeof projectMemory.maxRecallResults === "number"
      ? projectMemory.maxRecallResults
      : typeof globalMemory.maxRecallResults === "number"
        ? globalMemory.maxRecallResults
        : DEFAULT_RECALL_RESULTS) || DEFAULT_RECALL_RESULTS;

  const globalWriter = asRecord(globalMemory.writer) ?? {};
  const projectWriter = asRecord(projectMemory.writer) ?? {};
  const writerEnabled =
    typeof projectWriter.enabled === "boolean"
      ? projectWriter.enabled
      : typeof globalWriter.enabled === "boolean"
        ? globalWriter.enabled
        : true;
  const writerMaxTokens =
    (typeof projectWriter.maxTokens === "number"
      ? projectWriter.maxTokens
      : typeof globalWriter.maxTokens === "number"
        ? globalWriter.maxTokens
        : DEFAULT_WRITER_MAX_TOKENS) || DEFAULT_WRITER_MAX_TOKENS;

  return {
    enabled,
    storageDir: expandHomePath(storageDir),
    maxCoreTokens,
    maxRecallResults,
    writer: {
      enabled: writerEnabled,
      maxTokens: writerMaxTokens,
    },
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[`"'()[\]{}<>]/g, " ")
      .replace(/[^a-z0-9._:/+-]+/g, " "),
  );
}

function tokenize(value: string): string[] {
  const seen = new Set<string>();
  for (const token of normalizeSearchText(value).split(" ")) {
    if (token.length < 2) {
      continue;
    }
    seen.add(token);
  }
  return Array.from(seen);
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function buildDbFileName(identity: RuntimeMemoryIdentity): string {
  const slug = identity.key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha256")
    .update(identity.key)
    .digest("hex")
    .slice(0, 12);
  return `${slug}-${hash}.sqlite`;
}

function parseAgentIdFromSessionKey(value: string): string | null {
  const match = value.match(/^agent:([^:]+):companion:[^:]+$/);
  return match?.[1] ?? null;
}

function parseAgentIdFromSanitizedSessionKey(value: string): string | null {
  if (!value.startsWith("agent_")) {
    return null;
  }
  const marker = "_companion_";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex <= "agent_".length) {
    return null;
  }
  return value.slice("agent_".length, markerIndex);
}

function resolveIdentity(params: {
  sessionManager: ReadonlySessionManager;
  settingsManager: SettingsManager;
}): RuntimeMemoryIdentity | null {
  const settings = asRecord(params.settingsManager.getGlobalSettings()) ?? {};
  const sessionDirName = basename(params.sessionManager.getSessionDir());
  const sessionAgentId = parseAgentIdFromSanitizedSessionKey(sessionDirName);
  if (sessionAgentId) {
    return { key: `agent:${sessionAgentId}`, scope: "agent" };
  }

  const directSessionKey = asString(settings.sessionKey);
  const directAgentId = directSessionKey
    ? parseAgentIdFromSessionKey(directSessionKey)
    : null;
  if (directAgentId) {
    return { key: `agent:${directAgentId}`, scope: "agent" };
  }

  const companion = asRecord(settings.companion);
  const explicitCompanionId = asString(companion?.id);
  if (explicitCompanionId) {
    return { key: `companion:${explicitCompanionId}`, scope: "companion" };
  }

  const sandboxHandle = asString(settings.sandboxHandle);
  if (sandboxHandle) {
    return { key: `sandbox:${sandboxHandle}`, scope: "sandbox" };
  }

  return null;
}

function extractTextFromMessage(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") {
    return "";
  }

  if (typeof message.content === "string") {
    return normalizeWhitespace(message.content);
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return normalizeWhitespace(
    message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}

function createSearchText(memory: {
  bucket: RuntimeMemoryBucket;
  kind: RuntimeMemoryKind;
  key: string;
  content: string;
}): string {
  return normalizeSearchText(
    `${memory.bucket} ${memory.kind} ${memory.key} ${memory.content}`,
  );
}

function createEpisodeSearchText(
  role: "user" | "assistant",
  text: string,
): string {
  return normalizeSearchText(`${role} ${text}`);
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function trimSnippet(value: string, maxChars = 220): string {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

function isMemoryBucket(value: unknown): value is RuntimeMemoryBucket {
  return value === "core" || value === "archival";
}

function isMemoryKind(value: unknown): value is RuntimeMemoryKind {
  return (
    value === "profile" ||
    value === "preference" ||
    value === "relationship" ||
    value === "fact" ||
    value === "secret"
  );
}

function defaultBucketForKind(kind: RuntimeMemoryKind): RuntimeMemoryBucket {
  switch (kind) {
    case "profile":
    case "preference":
    case "relationship":
      return "core";
    case "fact":
    case "secret":
      return "archival";
  }
}

function normalizeMemoryKey(value: string): string {
  const normalized = normalizeSearchText(value).replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : "memory";
}

function unwrapJson(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return text.trim();
}

function scoreCandidate(
  searchText: string,
  queryTokens: string[],
  rawText: string,
  timestamp: number,
  boost = 0,
): number {
  if (queryTokens.length === 0) {
    return 1;
  }

  let score = boost;
  let matchedAll = true;
  for (const token of queryTokens) {
    if (searchText.includes(token)) {
      score += token.length >= 5 ? 16 : 10;
    } else {
      matchedAll = false;
    }
  }

  const normalizedRaw = normalizeSearchText(rawText);
  const phrase = normalizeSearchText(queryTokens.join(" "));
  if (phrase.length > 0 && normalizedRaw.includes(phrase)) {
    score += 24;
  }
  if (matchedAll) {
    score += 14;
  }

  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  score += Math.max(0, 8 - ageDays / 14);

  return score;
}

function listMarkdownFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function readLegacyMemoryFiles(baseDir: string): LegacyMemoryFile[] {
  const files = listMarkdownFiles(join(baseDir, "core", "user"));
  return files
    .map((filePath) => {
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = parseFrontmatter<Record<string, unknown>>(raw);
        const body = normalizeWhitespace(parsed.body);
        if (!body) {
          return null;
        }
        return { path: filePath, body };
      } catch {
        return null;
      }
    })
    .filter((file): file is LegacyMemoryFile => file !== null);
}

function guessLegacyKind(filePath: string, body: string): RuntimeMemoryKind {
  const lowerPath = filePath.toLowerCase();
  const lowerBody = body.toLowerCase();
  if (lowerPath.includes("prefer") || lowerBody.includes("preferences")) {
    return "preference";
  }
  if (
    lowerPath.includes("identity") ||
    lowerBody.includes("about your human") ||
    lowerBody.includes("user identity")
  ) {
    return "profile";
  }
  return "relationship";
}

export class RuntimeMemoryManager {
  private readonly sessionManager: ReadonlySessionManager;
  private readonly settingsManager: SettingsManager;
  private readonly settings: Required<CompanionMemorySettings> & {
    writer: { enabled: boolean; maxTokens: number };
  };
  private readonly identity: RuntimeMemoryIdentity | null;
  private readonly dbPath: string | null;
  private readonly database: DatabaseSync | null;

  constructor(params: {
    sessionManager: ReadonlySessionManager;
    settingsManager: SettingsManager;
  }) {
    this.sessionManager = params.sessionManager;
    this.settingsManager = params.settingsManager;
    this.settings = getCompanionMemorySettings(params.settingsManager);
    this.identity = this.settings.enabled ? resolveIdentity(params) : null;

    if (!this.settings.enabled || !this.identity) {
      this.dbPath = null;
      this.database = null;
      return;
    }

    mkdirSync(this.settings.storageDir, { recursive: true });
    this.dbPath = join(
      this.settings.storageDir,
      buildDbFileName(this.identity),
    );
    this.database = new DatabaseSync(this.dbPath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA synchronous = NORMAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket TEXT NOT NULL,
        kind TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        content TEXT NOT NULL,
        search_text TEXT NOT NULL,
        source TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        superseded_at INTEGER,
        superseded_by_id INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_active_key
        ON memories(memory_key)
        WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_memories_bucket_active
        ON memories(bucket, active, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at
        ON memories(updated_at DESC);

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_ref TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        search_text TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_timestamp
        ON episodes(timestamp DESC);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.runLegacyImport();
  }

  dispose(): void {
    this.database?.close();
  }

  isEnabled(): boolean {
    return this.database !== null && this.identity !== null;
  }

  getStatus(): RuntimeMemoryStatus {
    if (!this.database || !this.identity) {
      return {
        enabled: this.settings.enabled,
        ready: false,
        identity: null,
        storagePath: null,
        coreCount: 0,
        archivalCount: 0,
        episodeCount: 0,
        lastMemoryWriteAt: null,
        lastEpisodeAt: null,
        legacyImportComplete: false,
      };
    }

    const counts = this.database
      .prepare(
        `SELECT
           SUM(CASE WHEN bucket = 'core' AND active = 1 THEN 1 ELSE 0 END) AS core_count,
           SUM(CASE WHEN bucket = 'archival' AND active = 1 THEN 1 ELSE 0 END) AS archival_count
         FROM memories`,
      )
      .get() as { core_count?: number | null; archival_count?: number | null };
    const episodeCountRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM episodes`)
      .get() as { count: number };
    const lastMemoryWrite = this.database
      .prepare(`SELECT MAX(updated_at) AS updated_at FROM memories`)
      .get() as { updated_at?: number | null };
    const lastEpisodeWrite = this.database
      .prepare(`SELECT MAX(timestamp) AS timestamp FROM episodes`)
      .get() as { timestamp?: number | null };

    return {
      enabled: true,
      ready: true,
      identity: this.identity,
      storagePath: this.dbPath,
      coreCount: counts.core_count ?? 0,
      archivalCount: counts.archival_count ?? 0,
      episodeCount: episodeCountRow.count,
      lastMemoryWriteAt: lastMemoryWrite.updated_at ?? null,
      lastEpisodeAt: lastEpisodeWrite.timestamp ?? null,
      legacyImportComplete:
        this.getMetadata("legacy_import_complete") === "true",
    };
  }

  listCoreMemories(): RuntimeMemoryRecord[] {
    if (!this.database) {
      return [];
    }

    const rows = this.database
      .prepare(
        `SELECT
           id,
           bucket,
           kind,
           memory_key,
           content,
           source,
           created_at,
           updated_at,
           last_accessed_at,
           search_text
         FROM memories
         WHERE active = 1 AND bucket = 'core'
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as MemoryRow[];
    return rows.map((row) => this.mapMemoryRow(row));
  }

  search(
    query: string,
    limit = DEFAULT_RECALL_RESULTS,
  ): RuntimeMemorySearchResult {
    if (!this.database) {
      return { query, results: [] };
    }

    const queryText = normalizeWhitespace(query);
    const queryTokens = tokenize(queryText);
    const memoryRows = this.findRelevantMemories(
      queryTokens,
      Math.max(limit * 4, 12),
    );
    const episodeRows = this.findRelevantEpisodes(
      queryTokens,
      Math.max(limit * 4, 20),
    );
    const results: RuntimeMemorySearchResultItem[] = [];

    for (const row of memoryRows) {
      const boost = row.kind === "secret" ? 6 : row.bucket === "core" ? 3 : 0;
      const score = scoreCandidate(
        row.search_text,
        queryTokens,
        `${row.memory_key} ${row.content}`,
        row.updated_at,
        boost,
      );
      if (score <= 0) {
        continue;
      }
      results.push({
        id: row.id,
        sourceType: "memory",
        score,
        kind: row.kind,
        bucket: row.bucket,
        key: row.memory_key,
        content: row.content,
        source: row.source,
        timestamp: row.updated_at,
      });
    }

    for (const row of episodeRows) {
      const score = scoreCandidate(
        row.search_text,
        queryTokens,
        row.text,
        row.timestamp,
        row.role === "assistant" ? 1 : 0,
      );
      if (score <= 0) {
        continue;
      }
      results.push({
        id: row.id,
        sourceType: "episode",
        score,
        role: row.role,
        content: row.text,
        timestamp: row.timestamp,
      });
    }

    results.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.timestamp - left.timestamp;
    });

    return {
      query: queryText,
      results: results.slice(0, limit),
    };
  }

  remember(input: RuntimeMemoryRememberInput): RuntimeMemoryRecord | null {
    if (!this.database) {
      return null;
    }

    const content = normalizeWhitespace(input.content);
    if (!content) {
      return null;
    }

    const kind = input.kind ?? "fact";
    const bucket = input.bucket ?? defaultBucketForKind(kind);
    const memoryKey = normalizeMemoryKey(input.key ?? content);
    const now = Date.now();

    const existing = this.database
      .prepare(
        `SELECT
           id,
           bucket,
           kind,
           memory_key,
           content,
           source,
           created_at,
           updated_at,
           last_accessed_at,
           search_text
         FROM memories
         WHERE memory_key = ? AND active = 1`,
      )
      .get(memoryKey) as MemoryRow | undefined;

    if (existing) {
      if (
        existing.content === content &&
        existing.bucket === bucket &&
        existing.kind === kind
      ) {
        this.database
          .prepare(
            `UPDATE memories
             SET updated_at = ?, last_accessed_at = ?
             WHERE id = ?`,
          )
          .run(now, now, existing.id);
        return this.getMemoryById(existing.id);
      }

      this.database
        .prepare(
          `UPDATE memories
           SET active = 0, superseded_at = ?
           WHERE id = ?`,
        )
        .run(now, existing.id);
    }

    const insertResult = this.database
      .prepare(
        `INSERT INTO memories (
           bucket,
           kind,
           memory_key,
           content,
           search_text,
           source,
           active,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        bucket,
        kind,
        memoryKey,
        content,
        createSearchText({
          bucket,
          kind,
          key: memoryKey,
          content,
        }),
        input.source ?? "manual",
        now,
        now,
      );

    return this.getMemoryById(Number(insertResult.lastInsertRowid));
  }

  forget(input: RuntimeMemoryForgetInput): { ok: true; forgotten: boolean } {
    if (!this.database) {
      return { ok: true, forgotten: false };
    }

    if (typeof input.id === "number") {
      const result = this.database
        .prepare(
          `UPDATE memories
           SET active = 0, superseded_at = ?
           WHERE id = ? AND active = 1`,
        )
        .run(Date.now(), input.id);
      return { ok: true, forgotten: result.changes > 0 };
    }

    if (input.key) {
      const result = this.database
        .prepare(
          `UPDATE memories
           SET active = 0, superseded_at = ?
           WHERE memory_key = ? AND active = 1`,
        )
        .run(Date.now(), normalizeMemoryKey(input.key));
      return { ok: true, forgotten: result.changes > 0 };
    }

    return { ok: true, forgotten: false };
  }

  rebuild(): RuntimeMemoryRebuildResult {
    if (!this.database) {
      return { ok: true, memoryRows: 0, episodeRows: 0 };
    }

    const memoryRows = this.database
      .prepare(
        `SELECT
           id,
           bucket,
           kind,
           memory_key,
           content,
           source,
           created_at,
           updated_at,
           last_accessed_at,
           search_text
         FROM memories`,
      )
      .all() as MemoryRow[];
    for (const row of memoryRows) {
      this.database
        .prepare(`UPDATE memories SET search_text = ? WHERE id = ?`)
        .run(
          createSearchText({
            bucket: row.bucket,
            kind: row.kind,
            key: row.memory_key,
            content: row.content,
          }),
          row.id,
        );
    }

    const episodeRows = this.database
      .prepare(`SELECT id, role, text, timestamp, search_text FROM episodes`)
      .all() as EpisodeRow[];
    for (const row of episodeRows) {
      this.database
        .prepare(`UPDATE episodes SET search_text = ? WHERE id = ?`)
        .run(createEpisodeSearchText(row.role, row.text), row.id);
    }

    this.database.exec("VACUUM;");

    return {
      ok: true,
      memoryRows: memoryRows.length,
      episodeRows: episodeRows.length,
    };
  }

  recordMessage(message: AgentMessage): void {
    if (!this.database) {
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return;
    }

    const text = clampText(extractTextFromMessage(message), MAX_EPISODE_CHARS);
    if (!text) {
      return;
    }

    this.database
      .prepare(
        `INSERT INTO episodes (
           session_id,
           session_ref,
           role,
           text,
           search_text,
           timestamp
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.sessionManager.getSessionId(),
        basename(this.sessionManager.getSessionDir()),
        message.role,
        text,
        createEpisodeSearchText(message.role, text),
        message.timestamp,
      );

    this.trimEpisodes();
  }

  async injectContext(
    messages: AgentMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<AgentMessage[]> {
    if (!this.database) {
      return messages;
    }

    options?.signal?.throwIfAborted?.();
    const lastUserIndex = findLastUserMessageIndex(messages);
    if (lastUserIndex === -1) {
      return messages;
    }

    const userMessage = messages[lastUserIndex];
    const userText = extractTextFromMessage(userMessage);
    if (!userText) {
      return messages;
    }

    const core = this.selectCoreRecall();
    const search = this.search(userText, this.settings.maxRecallResults);
    const memoryIds = search.results
      .filter(
        (
          item,
        ): item is RuntimeMemorySearchResultItem & { sourceType: "memory" } =>
          item.sourceType === "memory",
      )
      .map((item) => item.id);
    this.touchMemories(memoryIds);

    const memoryBlock = renderMemoryBlock(core, search.results);
    if (!memoryBlock) {
      return messages;
    }

    const injectedMessage: AgentMessage = {
      role: "custom",
      customType: CUSTOM_MEMORY_TYPE,
      content: memoryBlock,
      display: false,
      details: {
        identity: this.identity,
      },
      timestamp: Date.now(),
    };

    return [
      ...messages.slice(0, lastUserIndex + 1),
      injectedMessage,
      ...messages.slice(lastUserIndex + 1),
    ];
  }

  async promoteTurn(params: {
    model: Model<any> | undefined;
    apiKey: string | undefined;
    messages: AgentMessage[];
    signal?: AbortSignal;
  }): Promise<void> {
    if (!this.database || !this.settings.writer.enabled || !params.model) {
      return;
    }

    const userText = findLastRoleText(params.messages, "user");
    const assistantText = findLastRoleText(params.messages, "assistant");
    if (!userText || !assistantText) {
      return;
    }

    const response = await completeSimple(
      params.model,
      {
        systemPrompt: MEMORY_WRITER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: [
                  `Latest user message:`,
                  `<user>${userText}</user>`,
                  ``,
                  `Latest assistant reply:`,
                  `<assistant>${assistantText}</assistant>`,
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      params.model.reasoning
        ? {
            apiKey: params.apiKey,
            maxTokens: this.settings.writer.maxTokens,
            signal: params.signal,
            reasoning: "low",
          }
        : {
            apiKey: params.apiKey,
            maxTokens: this.settings.writer.maxTokens,
            signal: params.signal,
          },
    );

    if (response.stopReason === "error") {
      return;
    }

    const text = unwrapJson(
      response.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n"),
    );

    let parsed: MemoryWriterResponse | null = null;
    try {
      parsed = JSON.parse(text) as MemoryWriterResponse;
    } catch {
      parsed = null;
    }

    const candidates = Array.isArray(parsed?.memories) ? parsed.memories : [];
    const remembered = new Set<string>();
    for (const candidate of candidates) {
      if (!isMemoryKind(candidate.kind)) {
        continue;
      }
      const kind = candidate.kind;
      const bucket = isMemoryBucket(candidate.bucket)
        ? candidate.bucket
        : defaultBucketForKind(kind);
      const content = asString(candidate.content);
      if (!content) {
        continue;
      }

      const key = normalizeMemoryKey(
        asString(candidate.key) ?? trimSnippet(content, 80),
      );
      const dedupeKey = `${bucket}:${kind}:${key}`;
      if (remembered.has(dedupeKey)) {
        continue;
      }
      remembered.add(dedupeKey);
      this.remember({
        bucket,
        kind,
        key,
        content,
        source: "auto",
      });
    }

    if (remembered.size > 0) {
      return;
    }

    const fallback = inferFallbackMemory(userText);
    if (fallback) {
      this.remember({
        ...fallback,
        source: "auto",
      });
    }
  }

  private runLegacyImport(): void {
    if (
      !this.database ||
      this.getMetadata("legacy_import_complete") === "true"
    ) {
      return;
    }

    const legacyDir = resolveLegacyProjectDir(
      this.settingsManager,
      this.sessionManager.getCwd(),
    );
    if (!legacyDir) {
      this.setMetadata("legacy_import_complete", "true");
      return;
    }

    const stats = statSyncSafe(legacyDir);
    if (!stats?.isDirectory()) {
      this.setMetadata("legacy_import_complete", "true");
      return;
    }

    const legacyFiles = readLegacyMemoryFiles(legacyDir);
    for (const file of legacyFiles) {
      const kind = guessLegacyKind(file.path, file.body);
      this.remember({
        bucket: defaultBucketForKind(kind),
        kind,
        key: normalizeMemoryKey(`legacy:${basename(file.path, ".md")}`),
        content: trimSnippet(file.body, 500),
        source: "legacy-import",
      });
    }

    this.setMetadata("legacy_import_complete", "true");
  }

  private findRelevantMemories(
    queryTokens: string[],
    limit: number,
  ): MemoryRow[] {
    if (!this.database) {
      return [];
    }

    let sql = `
      SELECT
        id,
        bucket,
        kind,
        memory_key,
        content,
        source,
        created_at,
        updated_at,
        last_accessed_at,
        search_text
      FROM memories
      WHERE active = 1`;
    const values: string[] = [];
    if (queryTokens.length > 0) {
      sql += ` AND (${queryTokens.map(() => `instr(search_text, ?) > 0`).join(" OR ")})`;
      values.push(...queryTokens);
    }
    sql += ` ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;

    return this.database.prepare(sql).all(...values) as MemoryRow[];
  }

  private findRelevantEpisodes(
    queryTokens: string[],
    limit: number,
  ): EpisodeRow[] {
    if (!this.database) {
      return [];
    }

    let sql = `
      SELECT
        id,
        role,
        text,
        timestamp,
        search_text
      FROM episodes`;
    const values: string[] = [];
    if (queryTokens.length > 0) {
      sql += ` WHERE ${queryTokens.map(() => `instr(search_text, ?) > 0`).join(" OR ")}`;
      values.push(...queryTokens);
    }
    sql += ` ORDER BY timestamp DESC, id DESC LIMIT ${limit}`;

    return this.database.prepare(sql).all(...values) as EpisodeRow[];
  }

  private selectCoreRecall(): RuntimeMemoryRecord[] {
    if (!this.database) {
      return [];
    }

    const rows = this.database
      .prepare(
        `SELECT
           id,
           bucket,
           kind,
           memory_key,
           content,
           source,
           created_at,
           updated_at,
           last_accessed_at,
           search_text
         FROM memories
         WHERE active = 1 AND bucket = 'core' AND kind != 'secret'
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as MemoryRow[];

    const selected: RuntimeMemoryRecord[] = [];
    let usedTokens = 0;
    for (const row of rows) {
      const memory = this.mapMemoryRow(row);
      const nextTokens =
        estimateTextTokens(memory.content) + estimateTextTokens(memory.key);
      if (
        selected.length > 0 &&
        usedTokens + nextTokens > this.settings.maxCoreTokens
      ) {
        break;
      }
      selected.push(memory);
      usedTokens += nextTokens;
    }
    return selected;
  }

  private touchMemories(ids: number[]): void {
    if (!this.database || ids.length === 0) {
      return;
    }
    const unique = Array.from(new Set(ids));
    const placeholders = unique.map(() => "?").join(", ");
    this.database
      .prepare(
        `UPDATE memories
         SET last_accessed_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(Date.now(), ...unique);
  }

  private trimEpisodes(): void {
    if (!this.database) {
      return;
    }

    const countRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM episodes`)
      .get() as { count: number };
    if (countRow.count <= MAX_EPISODES) {
      return;
    }

    const overflow = countRow.count - MAX_EPISODES;
    this.database
      .prepare(
        `DELETE FROM episodes
         WHERE id IN (
           SELECT id FROM episodes
           ORDER BY timestamp ASC, id ASC
           LIMIT ?
         )`,
      )
      .run(overflow);
  }

  private getMemoryById(id: number): RuntimeMemoryRecord | null {
    if (!this.database) {
      return null;
    }
    const row = this.database
      .prepare(
        `SELECT
           id,
           bucket,
           kind,
           memory_key,
           content,
           source,
           created_at,
           updated_at,
           last_accessed_at,
           search_text
         FROM memories
         WHERE id = ?`,
      )
      .get(id) as MemoryRow | undefined;
    return row ? this.mapMemoryRow(row) : null;
  }

  private getMetadata(key: string): string | null {
    if (!this.database) {
      return null;
    }
    const row = this.database
      .prepare(`SELECT value FROM metadata WHERE key = ?`)
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setMetadata(key: string, value: string): void {
    if (!this.database) {
      return;
    }
    this.database
      .prepare(
        `INSERT INTO metadata (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private mapMemoryRow(row: MemoryRow): RuntimeMemoryRecord {
    return {
      id: row.id,
      bucket: row.bucket,
      kind: row.kind,
      key: row.memory_key,
      content: row.content,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }
}

function statSyncSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function resolveLegacyProjectDir(
  settingsManager: SettingsManager,
  cwd: string,
): string | null {
  const settings = asRecord(settingsManager.getGlobalSettings()) ?? {};
  const legacySettings = asRecord(settings["pi-memory-md"]) ?? {};
  const configuredRoot =
    asString(legacySettings.localPath) ?? join(homedir(), ".pi", "memory-md");
  const legacyRoot = expandHomePath(configuredRoot);
  const legacyProjectDir = join(legacyRoot, basename(cwd));
  if (existsSync(legacyProjectDir)) {
    return legacyProjectDir;
  }

  const hashedDir = join(
    legacyRoot,
    `${basename(cwd)}-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12)}`,
  );
  return existsSync(hashedDir) ? hashedDir : null;
}

function renderMemoryBlock(
  coreMemories: RuntimeMemoryRecord[],
  searchResults: RuntimeMemorySearchResultItem[],
): string | null {
  const lines: string[] = [];
  const coreIds = new Set(coreMemories.map((memory) => memory.id));

  if (coreMemories.length > 0) {
    lines.push("Companion Memory");
    lines.push("");
    lines.push("Core memory:");
    for (const memory of coreMemories) {
      lines.push(`- [${memory.kind}] ${memory.content}`);
    }
  }

  const memoryResults = searchResults.filter(
    (item) => item.sourceType === "memory" && !coreIds.has(item.id),
  );
  const episodeResults = searchResults.filter(
    (item) => item.sourceType === "episode",
  );

  if (memoryResults.length > 0) {
    if (lines.length === 0) {
      lines.push("Companion Memory");
      lines.push("");
    } else {
      lines.push("");
    }
    lines.push("Relevant long-term memory:");
    for (const result of memoryResults) {
      lines.push(`- [${result.kind}] ${trimSnippet(result.content)}`);
    }
  }

  if (episodeResults.length > 0) {
    if (lines.length === 0) {
      lines.push("Companion Memory");
      lines.push("");
    } else {
      lines.push("");
    }
    lines.push("Relevant past conversation snippets:");
    for (const result of episodeResults) {
      const date = new Date(result.timestamp).toISOString().slice(0, 10);
      lines.push(`- (${date}) ${trimSnippet(result.content)}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  lines.push("");
  lines.push(
    "Use this memory when it is relevant. If a memory might be outdated or ambiguous, verify it with the user.",
  );
  return lines.join("\n");
}

function findLastUserMessageIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function findLastRoleText(
  messages: AgentMessage[],
  role: "user" | "assistant",
): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === role) {
      const text = extractTextFromMessage(message);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function inferFallbackMemory(
  userText: string,
): Omit<RuntimeMemoryRememberInput, "source"> | null {
  const normalized = userText.toLowerCase();
  if (
    /\b(password|passcode|pin|token|secret|api key|door code|key code|wifi password)\b/i.test(
      userText,
    )
  ) {
    return {
      bucket: "archival",
      kind: "secret",
      key: normalizeMemoryKey(trimSnippet(userText, 80)),
      content: trimSnippet(userText, 300),
    };
  }

  if (/\bremember\b/i.test(normalized)) {
    return {
      bucket: "archival",
      kind: "fact",
      key: normalizeMemoryKey(trimSnippet(userText, 80)),
      content: trimSnippet(userText, 300),
    };
  }

  return null;
}
