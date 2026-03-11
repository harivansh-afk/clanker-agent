import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalAdapter from "../utils/terminal-adapter";
import { TmuxAdapter } from "./tmux-adapter";

describe("TmuxAdapter", () => {
  let adapter: TmuxAdapter;

  beforeEach(() => {
    adapter = new TmuxAdapter();
    vi.spyOn(terminalAdapter, "execCommand");
    delete process.env.TMUX;
    delete process.env.ZELLIJ;
    delete process.env.WEZTERM_PANE;
    delete process.env.TERM_PROGRAM;
    delete process.env.COLORTERM;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("detects tmux in headless runtimes when the binary is available", () => {
    const mockExecCommand = vi.mocked(terminalAdapter.execCommand);
    mockExecCommand.mockReturnValue({
      stdout: "tmux 3.4",
      stderr: "",
      status: 0,
    });

    expect(adapter.detect()).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["-V"]);
  });

  it("does not detect tmux in GUI terminals just because the binary exists", () => {
    process.env.COLORTERM = "truecolor";
    const mockExecCommand = vi.mocked(terminalAdapter.execCommand);
    mockExecCommand.mockReturnValue({
      stdout: "tmux 3.4",
      stderr: "",
      status: 0,
    });

    expect(adapter.detect()).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it("creates a detached team session when not already inside tmux", () => {
    const mockExecCommand = vi.mocked(terminalAdapter.execCommand);
    mockExecCommand.mockImplementation((_bin, args) => {
      if (args[0] === "has-session") {
        return { stdout: "", stderr: "missing", status: 1 };
      }
      if (args[0] === "new-session") {
        return { stdout: "%1\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(
      adapter.spawn({
        name: "worker",
        cwd: "/tmp/project",
        command: "companion",
        env: { COMPANION_TEAM_NAME: "demo", COMPANION_AGENT_NAME: "worker" },
      }),
    ).toBe("%1");

    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining([
        "new-session",
        "-d",
        "-s",
        "companion-teams-demo",
      ]),
    );
  });

  it("splits an existing detached session when not already inside tmux", () => {
    const mockExecCommand = vi.mocked(terminalAdapter.execCommand);
    mockExecCommand.mockImplementation((_bin, args) => {
      if (args[0] === "has-session") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (args[0] === "split-window") {
        return { stdout: "%2\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(
      adapter.spawn({
        name: "worker",
        cwd: "/tmp/project",
        command: "companion",
        env: { COMPANION_TEAM_NAME: "demo", COMPANION_AGENT_NAME: "worker" },
      }),
    ).toBe("%2");

    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["split-window", "-t", "companion-teams-demo:0"]),
    );
  });

  it("checks pane liveness by pane id", () => {
    const mockExecCommand = vi.mocked(terminalAdapter.execCommand);
    mockExecCommand.mockReturnValue({
      stdout: "%1\n%7\n",
      stderr: "",
      status: 0,
    });

    expect(adapter.isAlive("%7")).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}",
    ]);
  });
});
