import { describe, expect, it, vi } from "vitest";
import { GatewayRuntime } from "../src/core/gateway/runtime.js";

function createMockSession() {
  return {
    sessionId: "session-1",
    messages: [],
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    sessionManager: {
      getSessionDir: () => "/tmp/pi-gateway-test",
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
  processing: boolean,
) {
  const managedSession = {
    sessionKey,
    session,
    queue: [],
    processing,
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

describe("GatewayRuntime steer handling", () => {
  it("steers the active session instead of queueing a second prompt", async () => {
    const session = createMockSession();
    const runtime = createRuntime(session);
    addManagedSession(runtime, "chat", session, true);

    const result = await (
      runtime as unknown as {
        handleSteer: (
          sessionKey: string,
          text: string,
        ) => Promise<{ ok: true; mode: "steer" | "queued"; sessionKey: string }>;
      }
    ).handleSteer("chat", "keep going");

    expect(result).toEqual({
      ok: true,
      mode: "steer",
      sessionKey: "chat",
    });
    expect(session.steer).toHaveBeenCalledWith("keep going");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("queues a prompt immediately when steer races an idle session", async () => {
    const session = createMockSession();
    const runtime = createRuntime(session);
    addManagedSession(runtime, "chat", session, false);

    const result = await (
      runtime as unknown as {
        handleSteer: (
          sessionKey: string,
          text: string,
        ) => Promise<{ ok: true; mode: "steer" | "queued"; sessionKey: string }>;
      }
    ).handleSteer("chat", "pick this up next");

    expect(result).toEqual({
      ok: true,
      mode: "queued",
      sessionKey: "chat",
    });

    expect(session.steer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledWith("pick this up next", {
        images: undefined,
        source: "extension",
      });
    });
  });
});
