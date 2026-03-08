import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

export function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function createGatewaySessionManager(
  cwd: string,
  sessionKey: string,
  sessionDirRoot: string,
): SessionManager {
  return SessionManager.continueRecent(
    cwd,
    join(sessionDirRoot, sanitizeSessionKey(sessionKey)),
  );
}
