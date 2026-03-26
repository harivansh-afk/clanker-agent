import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/clanker-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getAgentDir } from "../../config.js";
import {
  getShellEnv,
  killProcessTree,
  sanitizeBinaryOutput,
} from "../../utils/shell.js";

const computerActions = [
  "observe",
  "click",
  "type",
  "hotkey",
  "scroll",
  "drag",
  "wait",
  "app_list",
  "app_open",
  "app_focus",
  "window_list",
  "window_focus",
  "window_move",
  "window_resize",
  "window_close",
  "clipboard_read",
  "clipboard_write",
] as const;

const computerObservationModes = ["hybrid", "ocr"] as const;
const computerSnapshotIdPattern = /^[A-Za-z0-9_-]+$/;

const DEFAULT_COMPUTER_COMMAND =
  process.env.CLANKER_AGENT_COMPUTER_COMMAND || "agent-computer";
const DEFAULT_COMPUTER_TIMEOUT_SECONDS = 90;

const computerSchema = Type.Object({
  action: Type.Union(
    computerActions.map((action) => Type.Literal(action)),
    { description: "Computer action to execute" },
  ),
  snapshotId: Type.Optional(
    Type.String({ description: "Snapshot ID returned from observe" }),
  ),
  ref: Type.Optional(
    Type.String({
      description:
        "Target ref from observe output, such as w1 for a window or t3 for OCR text",
    }),
  ),
  x: Type.Optional(Type.Number({ description: "Target x coordinate" })),
  y: Type.Optional(Type.Number({ description: "Target y coordinate" })),
  toRef: Type.Optional(
    Type.String({ description: "Destination ref for drag actions" }),
  ),
  toX: Type.Optional(
    Type.Number({ description: "Destination x coordinate for drag actions" }),
  ),
  toY: Type.Optional(
    Type.Number({ description: "Destination y coordinate for drag actions" }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "Text to type, text to wait for, or clipboard contents depending on action",
    }),
  ),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: "Hotkey chord or key sequence, for example ['ctrl', 'l']",
      minItems: 1,
    }),
  ),
  app: Type.Optional(
    Type.String({
      description:
        "Installed app or running app name/class for app_open, app_focus, and wait",
    }),
  ),
  windowId: Type.Optional(
    Type.String({ description: "Window ID, such as 0x04200007" }),
  ),
  windowTitle: Type.Optional(
    Type.String({ description: "Window title substring to match" }),
  ),
  mode: Type.Optional(
    Type.Union(
      computerObservationModes.map((mode) => Type.Literal(mode)),
      { description: "Observation mode. Defaults to hybrid." },
    ),
  ),
  amount: Type.Optional(
    Type.Number({
      description:
        "Scroll amount in wheel steps. Positive scrolls down/right, negative scrolls up/left.",
    }),
  ),
  width: Type.Optional(
    Type.Number({ description: "Target window width for resize actions" }),
  ),
  height: Type.Optional(
    Type.Number({ description: "Target window height for resize actions" }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description: "Clear the active input field before typing",
    }),
  ),
  button: Type.Optional(
    Type.Number({
      description: "Mouse button for click or drag. Defaults to 1.",
      minimum: 1,
      maximum: 7,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Wait timeout in milliseconds for observe-derived waits",
      minimum: 0,
    }),
  ),
  intervalMs: Type.Optional(
    Type.Number({
      description: "Polling interval for wait actions in milliseconds",
      minimum: 10,
    }),
  ),
});

export type ComputerToolAction = (typeof computerActions)[number];
export type ComputerObservationMode = (typeof computerObservationModes)[number];
export type ComputerToolInput = Static<typeof computerSchema>;

export interface ComputerToolDetails {
  action: ComputerToolAction;
  command: string;
  args: string[];
  stateDir: string;
  snapshotId?: string;
  screenshotPath?: string;
}

export interface ComputerOperations {
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

const defaultComputerOperations: ComputerOperations = {
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

export interface ComputerToolOptions {
  operations?: ComputerOperations;
  command?: string;
  defaultTimeoutSeconds?: number;
  stateDir?: string;
  agentDir?: string;
}

interface ComputerCommandContext {
  action: ComputerToolAction;
  args: string[];
  statusMessage: string;
  successMessage: string;
  stateDir: string;
}

function resolveCommandPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

function getComputerRootDir(options?: ComputerToolOptions): string {
  const baseAgentDir = options?.agentDir ?? getAgentDir();
  return join(baseAgentDir, "computer");
}

function getComputerStateDir(
  cwd: string,
  options?: ComputerToolOptions,
): string {
  const stateDir = options?.stateDir ?? getComputerRootDir(options);
  return resolveCommandPath(cwd, stateDir);
}

function ensureComputerDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
}

function normalizeOutput(chunks: Buffer[]): string {
  return sanitizeBinaryOutput(Buffer.concat(chunks).toString("utf-8")).trim();
}

function hasCoordinateTarget(input: ComputerToolInput): boolean {
  return input.x !== undefined && input.y !== undefined;
}

function hasRefTarget(input: ComputerToolInput): boolean {
  return input.snapshotId !== undefined && input.ref !== undefined;
}

function hasWindowTarget(input: ComputerToolInput): boolean {
  return input.windowId !== undefined || input.windowTitle !== undefined;
}

function hasDragDestination(input: ComputerToolInput): boolean {
  return (
    input.toRef !== undefined ||
    (input.toX !== undefined && input.toY !== undefined)
  );
}

function validateSnapshotId(snapshotId: string): void {
  if (!computerSnapshotIdPattern.test(snapshotId)) {
    throw new Error(`Invalid computer snapshotId: "${snapshotId}"`);
  }
}

function validateWaitInput(input: ComputerToolInput): void {
  const targetCount =
    (input.ref !== undefined ? 1 : 0) +
    (input.text !== undefined ? 1 : 0) +
    (input.app !== undefined ? 1 : 0) +
    (input.windowId !== undefined ? 1 : 0) +
    (input.windowTitle !== undefined ? 1 : 0);

  if (targetCount === 0 && input.timeoutMs === undefined) {
    throw new Error(
      "computer wait requires one of ref, text, app, windowId, windowTitle, or timeoutMs",
    );
  }

  if (targetCount > 1) {
    throw new Error(
      "computer wait requires exactly one of ref, text, app, windowId, or windowTitle",
    );
  }
}

function validateComputerInput(input: ComputerToolInput): void {
  if (input.snapshotId !== undefined) {
    validateSnapshotId(input.snapshotId);
  }

  switch (input.action) {
    case "observe":
    case "app_list":
    case "window_list":
    case "clipboard_read":
      return;
    case "click":
      if (!hasRefTarget(input) && !hasCoordinateTarget(input)) {
        throw new Error(
          "computer click requires snapshotId and ref, or explicit x and y coordinates",
        );
      }
      return;
    case "type":
      if (input.text === undefined) {
        throw new Error("computer type requires text");
      }
      if (input.ref !== undefined && input.snapshotId === undefined) {
        throw new Error("computer type with ref requires snapshotId");
      }
      return;
    case "hotkey":
      if (!input.keys || input.keys.length === 0) {
        throw new Error("computer hotkey requires keys");
      }
      return;
    case "scroll":
      if (input.amount === undefined || input.amount === 0) {
        throw new Error("computer scroll requires a non-zero amount");
      }
      if (input.ref !== undefined && input.snapshotId === undefined) {
        throw new Error("computer scroll with ref requires snapshotId");
      }
      return;
    case "drag":
      if (!hasRefTarget(input) && !hasCoordinateTarget(input)) {
        throw new Error(
          "computer drag requires a starting target via snapshotId and ref, or x and y coordinates",
        );
      }
      if (!hasDragDestination(input)) {
        throw new Error(
          "computer drag requires a destination via toRef, or explicit toX and toY coordinates",
        );
      }
      if (input.toRef !== undefined && input.snapshotId === undefined) {
        throw new Error("computer drag with toRef requires snapshotId");
      }
      return;
    case "wait":
      validateWaitInput(input);
      if (input.ref !== undefined && input.snapshotId === undefined) {
        throw new Error("computer wait with ref requires snapshotId");
      }
      return;
    case "app_open":
    case "app_focus":
      if (!input.app) {
        throw new Error(`computer ${input.action} requires app`);
      }
      return;
    case "window_focus":
    case "window_close":
      if (!hasWindowTarget(input)) {
        throw new Error(
          `computer ${input.action} requires windowId or windowTitle`,
        );
      }
      return;
    case "window_move":
      if (!hasWindowTarget(input)) {
        throw new Error(
          "computer window_move requires windowId or windowTitle",
        );
      }
      if (input.x === undefined || input.y === undefined) {
        throw new Error("computer window_move requires x and y");
      }
      return;
    case "window_resize":
      if (!hasWindowTarget(input)) {
        throw new Error(
          "computer window_resize requires windowId or windowTitle",
        );
      }
      if (input.width === undefined || input.height === undefined) {
        throw new Error("computer window_resize requires width and height");
      }
      return;
    case "clipboard_write":
      if (input.text === undefined) {
        throw new Error("computer clipboard_write requires text");
      }
      return;
    default: {
      const unsupportedAction: never = input.action;
      throw new Error(`Unsupported computer action: ${unsupportedAction}`);
    }
  }
}

function describeAction(input: ComputerToolInput): {
  statusMessage: string;
  successMessage: string;
} {
  switch (input.action) {
    case "observe":
      return {
        statusMessage: "Observing desktop...",
        successMessage: "Captured desktop snapshot",
      };
    case "click":
      return {
        statusMessage: "Clicking desktop target...",
        successMessage: "Clicked desktop target",
      };
    case "type":
      return {
        statusMessage: "Typing into desktop...",
        successMessage: "Typed into desktop",
      };
    case "hotkey":
      return {
        statusMessage: "Sending hotkey...",
        successMessage: "Sent hotkey",
      };
    case "scroll":
      return {
        statusMessage: "Scrolling desktop...",
        successMessage: "Scrolled desktop",
      };
    case "drag":
      return {
        statusMessage: "Dragging desktop target...",
        successMessage: "Dragged desktop target",
      };
    case "wait":
      return {
        statusMessage: "Waiting for desktop state...",
        successMessage: "Desktop wait condition satisfied",
      };
    case "app_list":
      return {
        statusMessage: "Listing apps...",
        successMessage: "Listed apps",
      };
    case "app_open":
      return {
        statusMessage: `Opening app ${input.app}...`,
        successMessage: `Opened app ${input.app}`,
      };
    case "app_focus":
      return {
        statusMessage: `Focusing app ${input.app}...`,
        successMessage: `Focused app ${input.app}`,
      };
    case "window_list":
      return {
        statusMessage: "Listing windows...",
        successMessage: "Listed windows",
      };
    case "window_focus":
      return {
        statusMessage: "Focusing window...",
        successMessage: "Focused window",
      };
    case "window_move":
      return {
        statusMessage: "Moving window...",
        successMessage: "Moved window",
      };
    case "window_resize":
      return {
        statusMessage: "Resizing window...",
        successMessage: "Resized window",
      };
    case "window_close":
      return {
        statusMessage: "Closing window...",
        successMessage: "Closed window",
      };
    case "clipboard_read":
      return {
        statusMessage: "Reading clipboard...",
        successMessage: "Read clipboard",
      };
    case "clipboard_write":
      return {
        statusMessage: "Writing clipboard...",
        successMessage: "Wrote clipboard",
      };
  }
}

function buildComputerCommand(
  cwd: string,
  input: ComputerToolInput,
  options?: ComputerToolOptions,
): ComputerCommandContext {
  validateComputerInput(input);

  const stateDir = getComputerStateDir(cwd, options);
  ensureComputerDir(stateDir);
  const actionDescription = describeAction(input);

  return {
    action: input.action,
    args: ["--state-dir", stateDir, "--input", JSON.stringify(input)],
    statusMessage: actionDescription.statusMessage,
    successMessage: actionDescription.successMessage,
    stateDir,
  };
}

function buildComputerErrorMessage(
  action: ComputerToolAction,
  output: string,
  exitCode: number | null,
): string {
  const base =
    exitCode === null
      ? `Computer action "${action}" failed`
      : `Computer action "${action}" exited with code ${exitCode}`;
  return output.length > 0 ? `${output}\n\n${base}` : base;
}

function getMissingComputerCommandMessage(command: string): string {
  return [
    `Computer tool could not find "${command}".`,
    "Desktop sandboxes install agent-computer alongside the browser tool.",
    "If you are running locally, either install the helper or omit the computer tool.",
    "Recommended setup inside a sandbox image: copy agent-computer into /usr/local/bin and install xdotool, wmctrl, tesseract-ocr, and xclip.",
  ].join("\n");
}

function parseComputerPayload(output: string): {
  text: string;
  snapshotId?: string;
  screenshotPath?: string;
} {
  if (output.length === 0) {
    return { text: "" };
  }

  try {
    const payload = JSON.parse(output) as {
      snapshot?: { snapshotId?: string; screenshotPath?: string };
      summary?: string;
      screenshotPath?: string;
      snapshotId?: string;
    };
    return {
      text: JSON.stringify(payload, null, 2),
      snapshotId: payload.snapshot?.snapshotId ?? payload.snapshotId,
      screenshotPath:
        payload.snapshot?.screenshotPath ?? payload.screenshotPath,
    };
  } catch {
    return { text: output };
  }
}

export function createComputerTool(
  cwd: string,
  options?: ComputerToolOptions,
): AgentTool<typeof computerSchema> {
  const operations = options?.operations ?? defaultComputerOperations;
  const command = options?.command ?? DEFAULT_COMPUTER_COMMAND;
  const defaultTimeoutSeconds =
    options?.defaultTimeoutSeconds ?? DEFAULT_COMPUTER_TIMEOUT_SECONDS;

  return {
    name: "computer",
    label: "computer",
    description:
      "Use the desktop computer when browser DOM control is not enough: observe the screen, interact with windows and apps, type, click, drag, scroll, wait for native UI changes, and read or write the clipboard.",
    parameters: computerSchema,
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const commandContext = buildComputerCommand(cwd, input, options);
      const details: ComputerToolDetails = {
        action: commandContext.action,
        command,
        args: commandContext.args,
        stateDir: commandContext.stateDir,
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
            buildComputerErrorMessage(commandContext.action, output, exitCode),
          );
        }

        const parsed = parseComputerPayload(output);
        if (parsed.snapshotId) {
          details.snapshotId = parsed.snapshotId;
        }
        if (parsed.screenshotPath) {
          details.screenshotPath = parsed.screenshotPath;
        }

        return {
          content: [
            {
              type: "text",
              text:
                parsed.text.length > 0
                  ? parsed.text
                  : commandContext.successMessage,
            },
          ],
          details,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          throw new Error(getMissingComputerCommandMessage(command));
        }
        if (error instanceof Error && error.message === "aborted") {
          throw new Error(`Computer action "${commandContext.action}" aborted`);
        }
        if (error instanceof Error && error.message.startsWith("timeout:")) {
          const seconds = error.message.split(":")[1];
          throw new Error(
            `Computer action "${commandContext.action}" timed out after ${seconds} seconds`,
          );
        }
        throw error;
      }
    },
  };
}

export const computerTool = createComputerTool(process.cwd());
