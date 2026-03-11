import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import {
  type BrowserOperations,
  type BrowserToolDetails,
  createAllTools,
  createBrowserTool,
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

interface BrowserExecCall {
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

function createMockBrowserOperations(
  output = "",
  exitCode: number | null = 0,
): {
  calls: BrowserExecCall[];
  operations: BrowserOperations;
} {
  const calls: BrowserExecCall[] = [];

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

describe("browser tool", () => {
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

  it("opens pages through agent-browser with a shared profile", async () => {
    const cwd = createTempDir("coding-agent-browser-open-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      command: "agent-browser-test",
      profileDir,
      stateDir,
    });

    const result = (await browserTool.execute("browser-open", {
      action: "open",
      url: "https://example.com",
    })) as ToolResultLike;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "agent-browser-test",
      args: ["--profile", profileDir, "open", "https://example.com"],
      cwd,
      timeout: 90,
    });
    expect(getTextOutput(result)).toBe("Opened https://example.com");

    const details = result.details as BrowserToolDetails | undefined;
    expect(details?.profilePath).toBe(profileDir);
  });

  it("can force agent-browser into headed mode for desktop sandboxes", async () => {
    const cwd = createTempDir("coding-agent-browser-headed-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
      headed: true,
    });

    await browserTool.execute("browser-open-headed", {
      action: "open",
      url: "https://example.com",
    });

    expect(calls[0]?.args).toEqual([
      "--profile",
      profileDir,
      "--headed",
      "open",
      "https://example.com",
    ]);
  });

  it("uses interactive snapshots by default and returns snapshot text", async () => {
    const cwd = createTempDir("coding-agent-browser-snapshot-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations(
      "main [ref=@e1]\nbutton [ref=@e2] Sign in",
    );

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    const result = (await browserTool.execute("browser-snapshot", {
      action: "snapshot",
    })) as ToolResultLike;

    expect(calls[0]?.args).toEqual(["--profile", profileDir, "snapshot", "-i"]);
    expect(getTextOutput(result)).toContain("button [ref=@e2] Sign in");
  });

  it("validates wait targets before spawning agent-browser", async () => {
    const cwd = createTempDir("coding-agent-browser-wait-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    await expect(
      browserTool.execute("browser-wait-missing", {
        action: "wait",
      }),
    ).rejects.toThrow(
      "browser wait requires exactly one of ref, url, text, ms, or loadState",
    );

    await expect(
      browserTool.execute("browser-wait-ambiguous", {
        action: "wait",
        ref: "@e2",
        text: "Done",
      }),
    ).rejects.toThrow(
      "browser wait requires exactly one of ref, url, text, ms, or loadState",
    );

    expect(calls).toHaveLength(0);
  });

  it("preserves empty string wait targets instead of falling through to loadState", async () => {
    const cwd = createTempDir("coding-agent-browser-wait-empty-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    await browserTool.execute("browser-wait-empty-text", {
      action: "wait",
      text: "",
    });

    expect(calls[0]?.args).toEqual([
      "--profile",
      profileDir,
      "wait",
      "--text",
      "",
    ]);
  });

  it("does not create browser directories when validation fails before command construction", async () => {
    const cwd = createTempDir("coding-agent-browser-invalid-open-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    await expect(
      browserTool.execute("browser-open-missing-url", {
        action: "open",
      }),
    ).rejects.toThrow("browser open requires url");

    expect(existsSync(profileDir)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("stores named state under the managed browser state directory", async () => {
    const cwd = createTempDir("coding-agent-browser-state-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { calls, operations } = createMockBrowserOperations();

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    const result = (await browserTool.execute("browser-state-save", {
      action: "state_save",
      stateName: "my session/prod",
    })) as ToolResultLike;

    const expectedStatePath = join(stateDir, "my-session-prod.json");
    expect(calls[0]?.args).toEqual([
      "--profile",
      profileDir,
      "state",
      "save",
      expectedStatePath,
    ]);

    const details = result.details as BrowserToolDetails | undefined;
    expect(details?.statePath).toBe(expectedStatePath);
    expect(getTextOutput(result)).toContain(expectedStatePath);
  });

  it("treats null exit codes as browser failures", async () => {
    const cwd = createTempDir("coding-agent-browser-null-exit-");
    const profileDir = join(cwd, "profile");
    const stateDir = join(cwd, "states");
    const { operations } = createMockBrowserOperations("browser crashed", null);

    const browserTool = createBrowserTool(cwd, {
      operations,
      profileDir,
      stateDir,
    });

    await expect(
      browserTool.execute("browser-open-null-exit", {
        action: "open",
        url: "https://example.com",
      }),
    ).rejects.toThrow('browser crashed\n\nBrowser action "open" failed');
  });

  it("accepts browser in --tools and exposes it in default tool wiring", () => {
    const parsed = parseArgs(["--tools", "browser,read"]);
    expect(parsed.tools).toEqual(["browser", "read"]);

    expect(defaultCodingToolNames).toContain("browser");
    expect(createAllTools(process.cwd()).browser.name).toBe("browser");
  });

  it("mentions browser in the default system prompt", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("- browser: Browse the web:");
    expect(prompt).toContain(
      "Browser: snapshot before interacting with elements",
    );
  });
});
