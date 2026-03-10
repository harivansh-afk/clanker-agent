export {
  type BashOperations,
  type BashSpawnContext,
  type BashSpawnHook,
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
  bashTool,
  createBashTool,
} from "./bash.js";
export {
  type BrowserLoadState,
  type BrowserOperations,
  type BrowserSnapshotMode,
  type BrowserToolAction,
  type BrowserToolDetails,
  type BrowserToolInput,
  type BrowserToolOptions,
  browserTool,
  createBrowserTool,
} from "./browser.js";
export {
  createEditTool,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  type EditToolOptions,
  editTool,
} from "./edit.js";
export {
  createFindTool,
  type FindOperations,
  type FindToolDetails,
  type FindToolInput,
  type FindToolOptions,
  findTool,
} from "./find.js";
export {
  createGrepTool,
  type GrepOperations,
  type GrepToolDetails,
  type GrepToolInput,
  type GrepToolOptions,
  grepTool,
} from "./grep.js";
export {
  createLsTool,
  type LsOperations,
  type LsToolDetails,
  type LsToolInput,
  type LsToolOptions,
  lsTool,
} from "./ls.js";
export {
  createReadTool,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
  readTool,
} from "./read.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
  truncateLine,
  truncateTail,
} from "./truncate.js";
export {
  createWriteTool,
  type WriteOperations,
  type WriteToolInput,
  type WriteToolOptions,
  writeTool,
} from "./write.js";

import type { AgentTool } from "@mariozechner/companion-agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import {
  browserTool,
  createBrowserTool,
  type BrowserToolOptions,
} from "./browser.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from companion-ai) */
export type Tool = AgentTool<any>;

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

// All available tools (using process.cwd())
export const allTools = {
  read: readTool,
  bash: bashTool,
  browser: browserTool,
  edit: editTool,
  write: writeTool,
  grep: grepTool,
  find: findTool,
  ls: lsTool,
};

export type ToolName = keyof typeof allTools;

export const defaultCodingToolNames: ToolName[] = [
  "read",
  "bash",
  "browser",
  "edit",
  "write",
];

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = defaultCodingToolNames.map(
  (toolName) => allTools[toolName],
);

export interface ToolsOptions {
  /** Options for the read tool */
  read?: ReadToolOptions;
  /** Options for the bash tool */
  bash?: BashToolOptions;
  /** Options for the browser tool */
  browser?: BrowserToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
  return [
    createReadTool(cwd, options?.read),
    createBashTool(cwd, options?.bash),
    createBrowserTool(cwd, options?.browser),
    createEditTool(cwd),
    createWriteTool(cwd),
  ];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(
  cwd: string,
  options?: ToolsOptions,
): Tool[] {
  return [
    createReadTool(cwd, options?.read),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(
  cwd: string,
  options?: ToolsOptions,
): Record<ToolName, Tool> {
  return {
    read: createReadTool(cwd, options?.read),
    bash: createBashTool(cwd, options?.bash),
    browser: createBrowserTool(cwd, options?.browser),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
}
