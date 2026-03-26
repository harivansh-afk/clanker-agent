import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/clanker-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import {
  getShellConfig,
  getShellEnv,
  killProcessTree,
} from "../../utils/shell.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateTail,
} from "./truncate.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `clanker-bash-${id}.log`);
}

/**
 * Default timeout applied when the LLM does not specify one.
 * Prevents indefinite hangs from long-running processes (dev servers, watchers, etc.)
 */
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * If no stdout/stderr output is received for this many seconds, kill the process.
 * Catches processes that are alive but idle (e.g. a backgrounded server after startup).
 */
const DEFAULT_NO_OUTPUT_TIMEOUT_SECONDS = 30;

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}s if not specified. Use a higher value for long-running builds or installations.`,
    }),
  ),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (e.g., SSH).
 */
export interface BashOperations {
  /**
   * Execute a command and stream output.
   * @param command - The command to execute
   * @param cwd - Working directory
   * @param options - Execution options
   * @returns Promise resolving to exit code (null if killed)
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * Default bash operations using local shell
 */
const defaultBashOperations: BashOperations = {
  exec: (command, cwd, { onData, signal, timeout, env }) => {
    return new Promise((resolve, reject) => {
      const { shell, args } = getShellConfig();

      if (!existsSync(cwd)) {
        reject(
          new Error(
            `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
          ),
        );
        return;
      }

      const child = spawn(shell, [...args, command], {
        cwd,
        detached: true,
        env: env ?? getShellEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;

      // Set timeout if provided
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeout * 1000);
      }

      // Stream stdout and stderr
      if (child.stdout) {
        child.stdout.on("data", onData);
      }
      if (child.stderr) {
        child.stderr.on("data", onData);
      }

      // Handle shell spawn errors
      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });

      // Handle abort signal - kill entire process tree
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

      // Handle process exit
      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }

        resolve({ exitCode: code });
      });
    });
  },
};

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook?: BashSpawnHook,
): BashSpawnContext {
  const baseContext: BashSpawnContext = {
    command,
    cwd,
    env: { ...getShellEnv() },
  };

  return spawnHook ? spawnHook(baseContext) : baseContext;
}

/**
 * Combine multiple AbortSignals into one. Aborts when any input signal fires.
 */
function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];

  const controller = new AbortController();
  for (const sig of defined) {
    if (sig.aborted) {
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell */
  operations?: BashOperations;
  /** Command prefix prepended to every command (e.g., "shopt -s expand_aliases" for alias support) */
  commandPrefix?: string;
  /** Hook to adjust command, cwd, or env before execution */
  spawnHook?: BashSpawnHook;
  /** Default timeout in seconds when LLM does not specify one. Set to 0 to disable. Default: 120 */
  defaultTimeoutSeconds?: number;
  /** Kill process if no output received for this many seconds. Set to 0 to disable. Default: 30 */
  noOutputTimeoutSeconds?: number;
}

export function createBashTool(
  cwd: string,
  options?: BashToolOptions,
): AgentTool<typeof bashSchema> {
  const ops = options?.operations ?? defaultBashOperations;
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;
  const configDefaultTimeout = options?.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const configNoOutputTimeout = options?.noOutputTimeoutSeconds ?? DEFAULT_NO_OUTPUT_TIMEOUT_SECONDS;

  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Default timeout is ${configDefaultTimeout}s - provide a higher timeout for long builds or installations.`,
    parameters: bashSchema,
    execute: async (
      _toolCallId: string,
      { command, timeout }: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?,
    ) => {
      // Apply default timeout when LLM does not specify one
      const effectiveTimeout = timeout ?? (configDefaultTimeout > 0 ? configDefaultTimeout : undefined);

      // Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
      const resolvedCommand = commandPrefix
        ? `${commandPrefix}\n${command}`
        : command;
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

      return new Promise((resolve, reject) => {
        // We'll stream to a temp file if output gets large
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        // No-output timeout: abort via AbortController when process goes silent.
        // This keeps the kill mechanism at the tool level, not inside BashOperations.
        let noOutputTimer: NodeJS.Timeout | undefined;
        let noOutputTriggered = false;
        const noOutputAbort = configNoOutputTimeout > 0 ? new AbortController() : undefined;

        // Combine caller signal and no-output signal
        const combinedSignal = noOutputAbort
          ? combineAbortSignals(signal, noOutputAbort.signal)
          : signal;

        const clearNoOutputTimer = () => {
          if (noOutputTimer) {
            clearTimeout(noOutputTimer);
            noOutputTimer = undefined;
          }
        };

        const resetNoOutputTimer = () => {
          if (!noOutputAbort) return;
          clearNoOutputTimer();
          noOutputTimer = setTimeout(() => {
            noOutputTriggered = true;
            noOutputAbort.abort();
          }, configNoOutputTimeout * 1000);
        };

        // Keep a rolling buffer of the last chunk for tail truncation
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        // Keep more than we need so we have enough for truncation
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Reset no-output timer on every chunk of output
          resetNoOutputTimer();

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFilePath();
            tempFileStream = createWriteStream(tempFilePath);
            // Write all buffered chunks to the file
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          // Write to temp file if we have one
          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Trim old chunks if buffer is too large
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }

          // Stream partial output to callback (truncated rolling buffer)
          if (onUpdate) {
            const fullBuffer = Buffer.concat(chunks);
            const fullText = fullBuffer.toString("utf-8");
            const truncation = truncateTail(fullText);
            onUpdate({
              content: [{ type: "text", text: truncation.content || "" }],
              details: {
                truncation: truncation.truncated ? truncation : undefined,
                fullOutputPath: tempFilePath,
              },
            });
          }
        };

        // Collect output and build final text (shared by success and error paths)
        const buildOutput = (): { text: string; details?: BashToolDetails } => {
          const fullBuffer = Buffer.concat(chunks);
          const fullOutput = fullBuffer.toString("utf-8");
          const truncation = truncateTail(fullOutput);
          let outputText = truncation.content || "(no output)";
          let details: BashToolDetails | undefined;

          if (truncation.truncated) {
            details = { truncation, fullOutputPath: tempFilePath };
            const startLine = truncation.totalLines - truncation.outputLines + 1;
            const endLine = truncation.totalLines;

            if (truncation.lastLinePartial) {
              const lastLineSize = formatSize(
                Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"),
              );
              outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
            } else if (truncation.truncatedBy === "lines") {
              outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
            } else {
              outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
            }
          }

          return { text: outputText, details };
        };

        // Start the no-output timer (will fire if command produces no output at all)
        resetNoOutputTimer();

        ops
          .exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal: combinedSignal,
            timeout: effectiveTimeout,
            env: spawnContext.env,
          })
          .then(({ exitCode }) => {
            clearNoOutputTimer();
            if (tempFileStream) tempFileStream.end();

            const { text, details } = buildOutput();

            if (noOutputTriggered) {
              reject(new Error(
                `${text}\n\nProcess was killed after ${configNoOutputTimeout}s of no output. If this is a long-running server or build, use a higher timeout or run the process in the background with '&' and redirect output.`,
              ));
              return;
            }

            if (exitCode !== 0 && exitCode !== null) {
              reject(new Error(`${text}\n\nCommand exited with code ${exitCode}`));
            } else {
              resolve({ content: [{ type: "text", text }], details });
            }
          })
          .catch((err: Error) => {
            clearNoOutputTimer();
            if (tempFileStream) tempFileStream.end();

            const { text } = buildOutput();

            if (noOutputTriggered) {
              reject(new Error(
                `${text}\n\nProcess was killed after ${configNoOutputTimeout}s of no output. If this is a long-running server or build, use a higher timeout or run the process in the background with '&' and redirect output.`,
              ));
            } else if (err.message === "aborted") {
              reject(new Error(text ? `${text}\n\nCommand aborted` : "Command aborted"));
            } else if (err.message.startsWith("timeout:")) {
              const timeoutSecs = err.message.split(":")[1];
              reject(new Error(text ? `${text}\n\nCommand timed out after ${timeoutSecs} seconds` : `Command timed out after ${timeoutSecs} seconds`));
            } else {
              reject(err);
            }
          });
      });
    },
  };
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());
