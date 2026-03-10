import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COMPANION_DIR = path.join(os.homedir(), ".companion");
export const TEAMS_DIR = path.join(COMPANION_DIR, "teams");
export const TASKS_DIR = path.join(COMPANION_DIR, "tasks");

export function ensureDirs() {
  if (!fs.existsSync(COMPANION_DIR)) fs.mkdirSync(COMPANION_DIR);
  if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR);
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR);
}

export function sanitizeName(name: string): string {
  // Allow only alphanumeric characters, hyphens, and underscores.
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(
      `Invalid name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }
  return name;
}

export function teamDir(teamName: string) {
  return path.join(TEAMS_DIR, sanitizeName(teamName));
}

export function taskDir(teamName: string) {
  return path.join(TASKS_DIR, sanitizeName(teamName));
}

export function inboxPath(teamName: string, agentName: string) {
  return path.join(
    teamDir(teamName),
    "inboxes",
    `${sanitizeName(agentName)}.json`,
  );
}

export function configPath(teamName: string) {
  return path.join(teamDir(teamName), "config.json");
}
