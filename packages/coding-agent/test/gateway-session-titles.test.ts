import { describe, expect, it, vi } from "vitest";
import { GatewayRuntime } from "../src/core/gateway/runtime.js";

function createMockSession(options?: { sessionName?: string }) {
  return {
    sessionId: "session-1",
    sessionName: options?.sessionName,
    messages: [],
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    sessionManager: {
      getSessionDir: () => "/tmp/companion-gateway-test",
      appendSessionInfo: vi.fn(),
      appendLabelChange: vi.fn(),
    },
  };
}

function createRuntime(session = createMockSession()) {
  return new GatewayRuntime({
    config: {
      bind: "127.0.0.1",
      port: 0,
      session: {
        idleMinutes: 5,
        maxQueuePerSession: 4,
      },
      webhook: {
        enabled: false,
        basePath: "/webhooks",
      },
    },
    primarySessionKey: "primary",
    primarySession: session as never,
    createSession: async () => session as never,
  });
}

function addManagedSession(
  runtime: GatewayRuntime,
  sessionKey: string,
  session: ReturnType<typeof createMockSession>,
) {
  const managedSession = {
    sessionKey,
    session,
    queue: [],
    processing: false,
    activeDurableRun: null,
    activeAssistantMessage: null,
    pendingToolResults: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    listeners: new Set(),
    unsubscribe: () => {},
  };

  (runtime as unknown as { sessions: Map<string, unknown> }).sessions.set(
    sessionKey,
    managedSession,
  );

  return managedSession;
}

describe("GatewayRuntime session titles", () => {
  it("includes the session name in snapshots", () => {
    const session = createMockSession({ sessionName: "Generated title" });
    const runtime = createRuntime(session);
    addManagedSession(runtime, "chat", session);

    expect(runtime.listSessions()).toEqual([
      expect.objectContaining({
        sessionKey: "chat",
        name: "Generated title",
      }),
    ]);
  });

  it("persists renamed sessions via session_info entries", async () => {
    const session = createMockSession();
    const runtime = createRuntime(session);
    addManagedSession(runtime, "chat", session);

    await (
      runtime as unknown as {
        handlePatchSession: (
          sessionKey: string,
          patch: { name?: string },
        ) => Promise<void>;
      }
    ).handlePatchSession("chat", { name: "Renamed title" });

    expect(session.sessionManager.appendSessionInfo).toHaveBeenCalledWith(
      "Renamed title",
    );
    expect(session.sessionManager.appendLabelChange).not.toHaveBeenCalled();
  });
});
