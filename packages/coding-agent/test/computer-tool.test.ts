import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import {
  type ComputerOperations,
  type ComputerToolDetails,
  createAllTools,
  createComputerTool,
  defaultCodingToolNames,
} from "../src/core/tools/index.js";

interface TextBlock {
  type: "text";
  text: string;
}

type ToolContentBlock = TextBlock | { type: string };

interface ToolResultLike {
  content: ToolContentBlock[];
  details?: unknown;
}

interface ComputerExecCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
}

function getTextOutput(result: ToolResultLike): string {
  return result.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function createMockComputerOperations(
  output = "",
  exitCode: number | null = 0,
): {
  calls: ComputerExecCall[];
  operations: ComputerOperations;
} {
  const calls: ComputerExecCall[] = [];

  return {
    calls,
    operations: {
      exec: async (command, args, options) => {
        calls.push({
          command,
          args,
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
        });
        if (output.length > 0) {
          options.onData(Buffer.from(output, "utf-8"));
        }
        return { exitCode };
      },
    },
  };
}

function getAgentComputerScriptPath(): string {
  return resolve(
    process.cwd(),
    "../../../../docker/clanker/agent-computer.js",
  );
}

describe("computer tool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it("observes the desktop through the agent-computer helper", async () => {
    const cwd = createTempDir("coding-agent-computer-observe-");
    const stateDir = join(cwd, "computer-state");
    const { calls, operations } = createMockComputerOperations(
      JSON.stringify({
        ok: true,
        action: "observe",
        summary: "Captured desktop snapshot snap-1",
        snapshot: {
          snapshotId: "snap-1",
          screenshotPath: "/tmp/snap-1.png",
          backend: "hybrid",
          activeWindow: null,
          windows: [],
          refs: [],
        },
      }),
    );

    const computerTool = createComputerTool(cwd, {
      operations,
      command: "agent-computer-test",
      stateDir,
    });

    const result = (await computerTool.execute("computer-observe", {
      action: "observe",
    })) as ToolResultLike;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "agent-computer-test",
      args: ["--state-dir", stateDir, "--input", '{"action":"observe"}'],
      cwd,
      timeout: 90,
    });

    const details = result.details as ComputerToolDetails | undefined;
    expect(details?.stateDir).toBe(stateDir);
    expect(details?.snapshotId).toBe("snap-1");
    expect(details?.screenshotPath).toBe("/tmp/snap-1.png");
    expect(getTextOutput(result)).toContain('"snapshotId": "snap-1"');
  });

  it("validates click targets before spawning the helper", async () => {
    const cwd = createTempDir("coding-agent-computer-click-");
    const stateDir = join(cwd, "computer-state");
    const { calls, operations } = createMockComputerOperations();

    const computerTool = createComputerTool(cwd, {
      operations,
      stateDir,
    });

    await expect(
      computerTool.execute("computer-click-missing-target", {
        action: "click",
      }),
    ).rejects.toThrow(
      "computer click requires snapshotId and ref, or explicit x and y coordinates",
    );

    expect(calls).toHaveLength(0);
  });

  it("rejects unsafe snapshot ids before spawning the helper", async () => {
    const cwd = createTempDir("coding-agent-computer-snapshot-id-");
    const stateDir = join(cwd, "computer-state");
    const { calls, operations } = createMockComputerOperations();

    const computerTool = createComputerTool(cwd, {
      operations,
      stateDir,
    });

    await expect(
      computerTool.execute("computer-click-invalid-snapshot", {
        action: "click",
        snapshotId: "../../auth",
        ref: "w1",
      }),
    ).rejects.toThrow('Invalid computer snapshotId: "../../auth"');

    expect(calls).toHaveLength(0);
  });

  it("accepts computer in --tools and exposes it in built-in tool wiring", () => {
    const parsed = parseArgs(["--tools", "computer,read"]);
    expect(parsed.tools).toEqual(["computer", "read"]);

    expect(defaultCodingToolNames).toContain("computer");
    expect(createAllTools(process.cwd()).computer.name).toBe("computer");
  });

  it("mentions computer in the default system prompt", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain(
      "- computer: Use the desktop computer: observe the screen",
    );
    expect(prompt).toContain(
      "Computer: observe before interacting. Use it for native UI",
    );
    expect(prompt).toContain(
      "Prefer browser for websites and DOM-aware tasks. Switch to computer",
    );
  });

  it("rejects accessibility observe mode until a non-screenshot backend exists", () => {
    const stateDir = createTempDir(
      "coding-agent-computer-helper-accessibility-",
    );
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        getAgentComputerScriptPath(),
        "--state-dir",
        stateDir,
        "--input",
        JSON.stringify({
          action: "observe",
          mode: "accessibility",
        }),
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "backend_unavailable: accessibility observe mode is not implemented",
    );
  });

  it("refuses to shell out when app_open cannot match an installed app", () => {
    const stateDir = createTempDir("coding-agent-computer-helper-app-open-");
    const markerPath = join(stateDir, "should-not-exist");
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        getAgentComputerScriptPath(),
        "--state-dir",
        stateDir,
        "--input",
        JSON.stringify({
          action: "app_open",
          app: `definitely-not-an-installed-app && touch ${markerPath}`,
        }),
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("app_not_found:");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects snapshot path traversal inside the helper", () => {
    const stateDir = createTempDir("coding-agent-computer-helper-snapshot-id-");
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        getAgentComputerScriptPath(),
        "--state-dir",
        stateDir,
        "--input",
        JSON.stringify({
          action: "click",
          snapshotId: "../../auth",
          ref: "w1",
        }),
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid_snapshot_id: ../../auth");
  });

  it("passes typed text after the xdotool option separator", () => {
    const stateDir = createTempDir("coding-agent-computer-helper-type-");
    const binDir = createTempDir("coding-agent-computer-helper-bin-");
    const argsPath = join(stateDir, "xdotool-args.json");
    const xdotoolPath = join(binDir, "xdotool");
    writeFileSync(
      xdotoolPath,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TEST_XDOTOOL_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`,
      "utf8",
    );
    chmodSync(xdotoolPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        getAgentComputerScriptPath(),
        "--state-dir",
        stateDir,
        "--input",
        JSON.stringify({
          action: "type",
          text: "--delay",
        }),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TEST_XDOTOOL_ARGS_PATH: argsPath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
      "type",
      "--delay",
      "12",
      "--clearmodifiers",
      "--",
      "--delay",
    ]);
  });
});
