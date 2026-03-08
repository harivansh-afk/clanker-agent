/**
 * Tmux Terminal Adapter
 *
 * Implements the TerminalAdapter interface for tmux terminal multiplexer.
 */

import {
  execCommand,
  type SpawnOptions,
  type TerminalAdapter,
} from "../utils/terminal-adapter";

export class TmuxAdapter implements TerminalAdapter {
  readonly name = "tmux";

  detect(): boolean {
    if (process.env.TMUX) return true;
    if (process.env.ZELLIJ || process.env.TERM_PROGRAM === "iTerm.app") {
      return false;
    }
    if (process.env.TERM_PROGRAM || process.env.COLORTERM) return false;
    if (process.env.WEZTERM_PANE) return false;
    return execCommand("tmux", ["-V"]).status === 0;
  }

  spawn(options: SpawnOptions): string {
    const envArgs = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`);

    let targetWindow: string | null = null;
    if (!process.env.TMUX) {
      const sessionName = `pi-teams-${options.env.PI_TEAM_NAME || "default"}`;
      targetWindow = `${sessionName}:0`;
      const hasSession = execCommand("tmux", [
        "has-session",
        "-t",
        sessionName,
      ]);
      if (hasSession.status !== 0) {
        const result = execCommand("tmux", [
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-P",
          "-F",
          "#{pane_id}",
          "-c",
          options.cwd,
          "env",
          ...envArgs,
          "sh",
          "-c",
          options.command,
        ]);

        if (result.status !== 0) {
          throw new Error(
            `tmux spawn failed with status ${result.status}: ${result.stderr}`,
          );
        }

        // The first pane becomes window 0; layout only matters once later spawns split it.
        return result.stdout.trim();
      }
    }

    const tmuxArgs = [
      "split-window",
      "-h",
      "-dP",
      "-F",
      "#{pane_id}",
      ...(targetWindow ? ["-t", targetWindow] : []),
      "-c",
      options.cwd,
      "env",
      ...envArgs,
      "sh",
      "-c",
      options.command,
    ];

    const result = execCommand("tmux", tmuxArgs);

    if (result.status !== 0) {
      throw new Error(
        `tmux spawn failed with status ${result.status}: ${result.stderr}`,
      );
    }

    // Apply layout after spawning
    execCommand("tmux", [
      "set-window-option",
      ...(targetWindow ? ["-t", targetWindow] : []),
      "main-pane-width",
      "60%",
    ]);
    execCommand("tmux", [
      "select-layout",
      ...(targetWindow ? ["-t", targetWindow] : []),
      "main-vertical",
    ]);

    return result.stdout.trim();
  }

  kill(paneId: string): void {
    if (
      !paneId ||
      paneId.startsWith("iterm_") ||
      paneId.startsWith("zellij_")
    ) {
      return; // Not a tmux pane
    }

    try {
      execCommand("tmux", ["kill-pane", "-t", paneId.trim()]);
    } catch {
      // Ignore errors - pane may already be dead
    }
  }

  isAlive(paneId: string): boolean {
    if (
      !paneId ||
      paneId.startsWith("iterm_") ||
      paneId.startsWith("zellij_")
    ) {
      return false; // Not a tmux pane
    }

    const result = execCommand("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}",
    ]);
    return (
      result.status === 0 &&
      result.stdout.split("\n").some((line) => line.trim() === paneId.trim())
    );
  }

  setTitle(title: string): void {
    try {
      execCommand("tmux", ["select-pane", "-T", title]);
    } catch {
      // Ignore errors
    }
  }

  /**
   * tmux does not support spawning separate OS windows
   */
  supportsWindows(): boolean {
    return false;
  }

  /**
   * Not supported - throws error
   */
  spawnWindow(_options: SpawnOptions): string {
    throw new Error(
      "tmux does not support spawning separate OS windows. Use iTerm2 or WezTerm instead.",
    );
  }

  /**
   * Not supported - no-op
   */
  setWindowTitle(_windowId: string, _title: string): void {
    // Not supported
  }

  /**
   * Not supported - no-op
   */
  killWindow(_windowId: string): void {
    // Not supported
  }

  /**
   * Not supported - always returns false
   */
  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
