import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/clanker-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getAgentDir } from "../../config.js";
import {
  getShellEnv,
  killProcessTree,
  sanitizeBinaryOutput,
} from "../../utils/shell.js";

const browserActions = [
  "open",
  "snapshot",
  "click",
  "fill",
  "wait",
  "screenshot",
  "state_save",
  "state_load",
  "close",
] as const;

const browserSnapshotModes = ["interactive", "full"] as const;
const browserLoadStates = ["load", "domcontentloaded", "networkidle"] as const;

const DEFAULT_BROWSER_COMMAND =
  process.env.CLANKER_AGENT_BROWSER_COMMAND || "agent-browser";
const DEFAULT_BROWSER_TIMEOUT_SECONDS = 90;

const browserSchema = Type.Object({
  action: Type.Union(
    browserActions.map((action) => Type.Literal(action)),
    { description: "Browser action to execute" },
  ),
  url: Type.Optional(
    Type.String({ description: "URL to open, or URL glob to wait for" }),
  ),
  mode: Type.Optional(
    Type.Union(
      browserSnapshotModes.map((mode) => Type.Literal(mode)),
      { description: "Snapshot mode. Defaults to interactive." },
    ),
  ),
  ref: Type.Optional(
    Type.String({
      description: "Element ref from snapshot output, such as @e2",
    }),
  ),
  value: Type.Optional(
    Type.String({ description: "Text value to fill into a field" }),
  ),
  text: Type.Optional(Type.String({ description: "Visible text to wait for" })),
  ms: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait",
      minimum: 0,
    }),
  ),
  loadState: Type.Optional(
    Type.Union(
      browserLoadStates.map((state) => Type.Literal(state)),
      { description: "Page load state to wait for" },
    ),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Output path for screenshots, relative to the current working directory if not absolute",
    }),
  ),
  fullPage: Type.Optional(
    Type.Boolean({ description: "Capture a full-page screenshot" }),
  ),
  stateName: Type.Optional(
    Type.String({
      description:
        "Named browser state checkpoint stored under ~/.clanker/agent/browser/states/",
    }),
  ),
});

export type BrowserToolAction = (typeof browserActions)[number];
export type BrowserSnapshotMode = (typeof browserSnapshotModes)[number];
export type BrowserLoadState = (typeof browserLoadStates)[number];
export type BrowserToolInput = Static<typeof browserSchema>;

export interface BrowserToolDetails {
  action: BrowserToolAction;
  command: string;
  args: string[];
  profilePath: string;
  screenshotPath?: string;
  statePath?: string;
}

export interface BrowserOperations {
  exec: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ) => Promise<{ exitCode: number | null }>;
}

const defaultBrowserOperations: BrowserOperations = {
  exec: (command, args, { cwd, env, onData, signal, timeout }) => {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeout * 1000);
      }

      if (child.stdout) {
        child.stdout.on("data", onData);
      }
      if (child.stderr) {
        child.stderr.on("data", onData);
      }

      const onAbort = () => {
        if (child.pid) {
          killProcessTree(child.pid);
        }
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.on("error", (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          rejectPromise(new Error("aborted"));
          return;
        }

        if (timedOut) {
          rejectPromise(new Error(`timeout:${timeout}`));
          return;
        }

        resolvePromise({ exitCode: code });
      });
    });
  },
};

export interface BrowserToolOptions {
  operations?: BrowserOperations;
  command?: string;
  defaultTimeoutSeconds?: number;
  profileDir?: string;
  stateDir?: string;
  agentDir?: string;
  headed?: boolean;
  windowClass?: string;
}

interface BrowserCommandContext {
  action: BrowserToolAction;
  args: string[];
  statusMessage: string;
  successMessage: string;
  profilePath: string;
  screenshotPath?: string;
  statePath?: string;
}

type BrowserCommandContextWithoutProfile = Omit<
  BrowserCommandContext,
  "profilePath"
>;

function resolveCommandPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

function getBrowserRootDir(options?: BrowserToolOptions): string {
  const baseAgentDir = options?.agentDir ?? getAgentDir();
  return join(baseAgentDir, "browser");
}

function getBrowserProfilePath(
  cwd: string,
  options?: BrowserToolOptions,
): string {
  const profilePath =
    options?.profileDir ?? join(getBrowserRootDir(options), "profile");
  return resolveCommandPath(cwd, profilePath);
}

function getBrowserStateDir(cwd: string, options?: BrowserToolOptions): string {
  const stateDir =
    options?.stateDir ?? join(getBrowserRootDir(options), "states");
  return resolveCommandPath(cwd, stateDir);
}

function createTempScreenshotPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `clanker-browser-screenshot-${id}.png`);
}

function normalizeOutput(chunks: Buffer[]): string {
  return sanitizeBinaryOutput(Buffer.concat(chunks).toString("utf-8")).trim();
}

function sanitizeStateName(stateName: string): string {
  const trimmed = stateName.trim();
  if (trimmed.length === 0) {
    throw new Error("stateName is required for browser state actions");
  }

  const withoutJsonSuffix = trimmed.endsWith(".json")
    ? trimmed.slice(0, -".json".length)
    : trimmed;
  const sanitized = withoutJsonSuffix
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sanitized.length === 0) {
    throw new Error(`Invalid browser state name: "${stateName}"`);
  }

  return sanitized;
}

function ensureBrowserDirs(profilePath: string, stateDir: string): void {
  mkdirSync(profilePath, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case "":
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return true;
  }
}

function shouldLaunchHeaded(options?: BrowserToolOptions): boolean {
  if (options?.headed !== undefined) {
    return options.headed;
  }
  return isTruthyEnv(process.env.CLANKER_AGENT_BROWSER_HEADED);
}

function getBrowserWindowClass(
  options?: BrowserToolOptions,
): string | undefined {
  const rawValue =
    options?.windowClass ?? process.env.CLANKER_BROWSER_WINDOW_CLASS;
  const windowClass = rawValue?.trim();
  return windowClass ? windowClass : undefined;
}

function createBrowserCommandContext(
  profilePath: string,
  stateDir: string,
  context: BrowserCommandContextWithoutProfile,
): BrowserCommandContext {
  ensureBrowserDirs(profilePath, stateDir);
  return {
    ...context,
    profilePath,
  };
}

function buildWaitArgs(input: BrowserToolInput): {
  args: string[];
  status: string;
} {
  const targets = [
    input.ref !== undefined ? "ref" : undefined,
    input.url !== undefined ? "url" : undefined,
    input.text !== undefined ? "text" : undefined,
    input.ms !== undefined ? "ms" : undefined,
    input.loadState !== undefined ? "loadState" : undefined,
  ].filter((target): target is string => target !== undefined);

  if (targets.length !== 1) {
    throw new Error(
      "browser wait requires exactly one of ref, url, text, ms, or loadState",
    );
  }

  if (input.ref !== undefined) {
    return { args: ["wait", input.ref], status: `Waiting for ${input.ref}...` };
  }
  if (input.url !== undefined) {
    return {
      args: ["wait", "--url", input.url],
      status: `Waiting for URL ${input.url}...`,
    };
  }
  if (input.text !== undefined) {
    return {
      args: ["wait", "--text", input.text],
      status: `Waiting for text "${input.text}"...`,
    };
  }
  if (input.ms !== undefined) {
    return {
      args: ["wait", String(input.ms)],
      status: `Waiting ${input.ms}ms...`,
    };
  }

  return {
    args: ["wait", "--load", input.loadState!],
    status: `Waiting for load state ${input.loadState}...`,
  };
}

function buildBrowserCommand(
  cwd: string,
  input: BrowserToolInput,
  options?: BrowserToolOptions,
): BrowserCommandContext {
  const profilePath = getBrowserProfilePath(cwd, options);
  const stateDir = getBrowserStateDir(cwd, options);
  const baseArgs = ["--profile", profilePath];
  if (shouldLaunchHeaded(options)) {
    baseArgs.push("--headed");
  }
  const windowClass = getBrowserWindowClass(options);
  if (windowClass) {
    baseArgs.push("--args", `--class=${windowClass}`);
  }

  switch (input.action) {
    case "open": {
      if (!input.url) {
        throw new Error("browser open requires url");
      }
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "open", input.url],
        statusMessage: `Opening ${input.url}...`,
        successMessage: `Opened ${input.url}`,
      });
    }
    case "snapshot": {
      const mode = input.mode ?? "interactive";
      const args =
        mode === "interactive"
          ? [...baseArgs, "snapshot", "-i"]
          : [...baseArgs, "snapshot"];
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args,
        statusMessage: "Capturing browser snapshot...",
        successMessage: "Captured browser snapshot",
      });
    }
    case "click": {
      if (!input.ref) {
        throw new Error("browser click requires ref");
      }
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "click", input.ref],
        statusMessage: `Clicking ${input.ref}...`,
        successMessage: `Clicked ${input.ref}`,
      });
    }
    case "fill": {
      if (!input.ref || input.value === undefined) {
        throw new Error("browser fill requires ref and value");
      }
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "fill", input.ref, input.value],
        statusMessage: `Filling ${input.ref}...`,
        successMessage: `Filled ${input.ref}`,
      });
    }
    case "wait": {
      const wait = buildWaitArgs(input);
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, ...wait.args],
        statusMessage: wait.status,
        successMessage: "Browser wait condition satisfied",
      });
    }
    case "screenshot": {
      const screenshotPath = input.path
        ? resolveCommandPath(cwd, input.path)
        : createTempScreenshotPath();
      const args = [...baseArgs, "screenshot"];
      if (input.fullPage) {
        args.push("--full");
      }
      args.push(screenshotPath);

      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args,
        statusMessage: "Taking browser screenshot...",
        successMessage: `Saved browser screenshot to ${screenshotPath}`,
        screenshotPath,
      });
    }
    case "state_save": {
      if (!input.stateName) {
        throw new Error("browser state_save requires stateName");
      }
      const statePath = join(
        stateDir,
        `${sanitizeStateName(input.stateName)}.json`,
      );
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "state", "save", statePath],
        statusMessage: `Saving browser state "${input.stateName}"...`,
        successMessage: `Saved browser state "${input.stateName}" to ${statePath}`,
        statePath,
      });
    }
    case "state_load": {
      if (!input.stateName) {
        throw new Error("browser state_load requires stateName");
      }
      const statePath = join(
        stateDir,
        `${sanitizeStateName(input.stateName)}.json`,
      );
      if (!existsSync(statePath)) {
        throw new Error(
          `Saved browser state "${input.stateName}" not found at ${statePath}`,
        );
      }
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "state", "load", statePath],
        statusMessage: `Loading browser state "${input.stateName}"...`,
        successMessage: `Loaded browser state "${input.stateName}" from ${statePath}`,
        statePath,
      });
    }
    case "close":
      return createBrowserCommandContext(profilePath, stateDir, {
        action: input.action,
        args: [...baseArgs, "close"],
        statusMessage: "Closing browser...",
        successMessage: "Closed browser",
      });
    default: {
      const unsupportedAction: never = input.action;
      throw new Error(`Unsupported browser action: ${unsupportedAction}`);
    }
  }
}

function buildBrowserErrorMessage(
  action: BrowserToolAction,
  output: string,
  exitCode: number | null,
): string {
  const base =
    exitCode === null
      ? `Browser action "${action}" failed`
      : `Browser action "${action}" exited with code ${exitCode}`;
  return output.length > 0 ? `${output}\n\n${base}` : base;
}

function getMissingBrowserCommandMessage(command: string): string {
  return [
    `Browser tool could not find "${command}".`,
    "Install agent-browser so the first-class browser tool can run.",
    "Recommended setup:",
    "  npm install -g agent-browser",
    "  agent-browser install",
    "If Chromium lives at a custom path, set AGENT_BROWSER_EXECUTABLE_PATH.",
  ].join("\n");
}

export function createBrowserTool(
  cwd: string,
  options?: BrowserToolOptions,
): AgentTool<typeof browserSchema> {
  const operations = options?.operations ?? defaultBrowserOperations;
  const command = options?.command ?? DEFAULT_BROWSER_COMMAND;
  const defaultTimeoutSeconds =
    options?.defaultTimeoutSeconds ?? DEFAULT_BROWSER_TIMEOUT_SECONDS;

  return {
    name: "browser",
    label: "browser",
    description:
      "Use a persistent browser for websites: open pages, inspect them with snapshot, click or fill elements, wait for changes, take screenshots, and save or load named browser state.",
    parameters: browserSchema,
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const commandContext = buildBrowserCommand(cwd, input, options);
      const details: BrowserToolDetails = {
        action: commandContext.action,
        command,
        args: commandContext.args,
        profilePath: commandContext.profilePath,
        screenshotPath: commandContext.screenshotPath,
        statePath: commandContext.statePath,
      };

      onUpdate?.({
        content: [{ type: "text", text: commandContext.statusMessage }],
        details,
      });

      const chunks: Buffer[] = [];

      try {
        const { exitCode } = await operations.exec(
          command,
          commandContext.args,
          {
            cwd,
            env: getShellEnv(),
            onData: (data) => chunks.push(data),
            signal,
            timeout: defaultTimeoutSeconds,
          },
        );

        const output = normalizeOutput(chunks);
        if (exitCode !== 0) {
          throw new Error(
            buildBrowserErrorMessage(commandContext.action, output, exitCode),
          );
        }

        if (commandContext.action === "snapshot") {
          if (output.length === 0) {
            throw new Error("Browser snapshot returned no output");
          }
          return {
            content: [{ type: "text", text: output }],
            details,
          };
        }

        const text = output.length > 0 ? output : commandContext.successMessage;
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          throw new Error(getMissingBrowserCommandMessage(command));
        }
        if (error instanceof Error && error.message === "aborted") {
          throw new Error(`Browser action "${commandContext.action}" aborted`);
        }
        if (error instanceof Error && error.message.startsWith("timeout:")) {
          const seconds = error.message.split(":")[1];
          throw new Error(
            `Browser action "${commandContext.action}" timed out after ${seconds} seconds`,
          );
        }
        throw error;
      }
    },
  };
}

export const browserTool = createBrowserTool(process.cwd());
