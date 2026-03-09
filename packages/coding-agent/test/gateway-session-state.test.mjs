import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGatewaySessionStateMessages,
  messageContentToHistoryParts,
} from "../src/core/gateway/session-state.ts";

test("messageContentToHistoryParts converts assistant text, reasoning, and tool calls", () => {
  const parts = messageContentToHistoryParts({
    role: "assistant",
    timestamp: 123,
    content: [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "working" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: { cmd: "pwd" },
      },
    ],
  });

  assert.deepEqual(parts, [
    { type: "text", text: "hello" },
    { type: "reasoning", text: "working" },
    {
      type: "tool-invocation",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { cmd: "pwd" },
      state: "call",
    },
  ]);
});

test("buildGatewaySessionStateMessages includes the active assistant draft while a run is still processing", () => {
  const messages = buildGatewaySessionStateMessages({
    sessionKey: "agent:test:chat",
    rawMessages: [
      {
        role: "user",
        timestamp: 100,
        content: "build a todo app",
      },
    ],
    activeAssistantMessage: {
      role: "assistant",
      timestamp: 200,
      content: [
        { type: "text", text: "Working on it" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "write",
          arguments: { filePath: "app.tsx" },
        },
      ],
    },
    pendingToolResults: [],
  });

  assert.deepEqual(messages, [
    {
      id: "100-user-0",
      role: "user",
      parts: [{ type: "text", text: "build a todo app" }],
      timestamp: 100,
    },
    {
      id: "draft:agent:test:chat:200",
      role: "assistant",
      parts: [
        { type: "text", text: "Working on it" },
        {
          type: "tool-invocation",
          toolCallId: "tool-1",
          toolName: "write",
          args: { filePath: "app.tsx" },
          state: "call",
        },
      ],
      timestamp: 200,
    },
  ]);
});

test("buildGatewaySessionStateMessages keeps transient tool results until persisted history catches up", () => {
  const messages = buildGatewaySessionStateMessages({
    sessionKey: "agent:test:chat",
    rawMessages: [
      {
        role: "user",
        timestamp: 100,
        content: "ship it",
      },
      {
        role: "toolResult",
        timestamp: 210,
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        isError: false,
      },
    ],
    activeAssistantMessage: null,
    pendingToolResults: [
      {
        toolCallId: "tool-1",
        toolName: "bash",
        result: { stdout: "done" },
        isError: false,
        timestamp: 220,
      },
      {
        toolCallId: "tool-2",
        toolName: "write",
        result: { path: "README.md" },
        isError: false,
        timestamp: 240,
      },
    ],
  });

  assert.deepEqual(messages, [
    {
      id: "100-user-0",
      role: "user",
      parts: [{ type: "text", text: "ship it" }],
      timestamp: 100,
    },
    {
      id: "210-toolResult-1",
      role: "toolResult",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "tool-1",
          toolName: "bash",
          args: undefined,
          state: "result",
          result: "done",
        },
      ],
      timestamp: 210,
    },
    {
      id: "draft-tool:agent:test:chat:tool-2",
      role: "toolResult",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "tool-2",
          toolName: "write",
          args: undefined,
          state: "result",
          result: { path: "README.md" },
        },
      ],
      timestamp: 240,
    },
  ]);
});
