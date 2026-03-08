import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalAdapter from "../utils/terminal-adapter";
import { TmuxAdapter } from "./tmux-adapter";

describe("TmuxAdapter", () => {
  let adapter: TmuxAdapter;
  let mockExecCommand: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new TmuxAdapter();
    mockExecCommand = vi.spyOn(terminalAdapter, "execCommand");
    delete process.env.TMUX;
    delete process.env.ZELLIJ;
    delete process.env.WEZTERM_PANE;
    delete process.env.TERM_PROGRAM;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("detects tmux in headless runtimes when the binary is available", () => {
    mockExecCommand.mockReturnValue({
      stdout: "tmux 3.4",
      stderr: "",
      status: 0,
    });

    expect(adapter.detect()).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["-V"]);
  });

  it("creates a detached team session when not already inside tmux", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
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
        command: "pi",
        env: { PI_TEAM_NAME: "demo", PI_AGENT_NAME: "worker" },
      }),
    ).toBe("%1");

    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session", "-d", "-s", "pi-teams-demo"]),
    );
  });

  it("checks pane liveness by pane id", () => {
    mockExecCommand.mockReturnValue({
      stdout: "%7\n",
      stderr: "",
      status: 0,
    });

    expect(adapter.isAlive("%7")).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", [
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{pane_id}",
    ]);
  });
});
