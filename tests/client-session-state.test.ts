import { describe, expect, it, vi } from "vitest";

import { applySessionEvent, updatedSnapshotBytes } from "../src/client/use-session-socket.js";
import type { ServerEvent, SessionSnapshot, TranscriptMessage } from "../src/shared/protocol.js";

const first: TranscriptMessage = {
  kind: "message",
  id: "first",
  role: "user",
  blocks: [{ type: "text", text: "one" }],
  timestamp: 1,
};
const second: TranscriptMessage = {
  kind: "message",
  id: "second",
  role: "assistant",
  blocks: [{ type: "text", text: "two" }],
  timestamp: 2,
};
const snapshot: SessionSnapshot = {
  identity: {
    id: "session",
    projectId: "project",
    projectName: "Project",
    projectPath: "/tmp/project",
  },
  transcript: [first],
  streamingMessage: null,
  tools: {},
  runtime: {
    phase: "idle",
    status: "idle",
    isBusy: false,
    queueDepth: 0,
    updatedAt: 1,
  },
  queue: { revision: 0, messages: [] },
  models: [],
  currentModel: null,
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  contextUsage: null,
  commands: [],
  permissionsNotice: "Not sandboxed",
  truncated: false,
};

describe("client session event reducer", () => {
  it("applies live queue updates", () => {
    const updated = applySessionEvent(snapshot, {
      type: "queue_updated",
      queue: {
        revision: 1,
        messages: [
          {
            id: "queue-1",
            text: "Check the tests too",
            streamingBehavior: "followUp",
            imageCount: 0,
            truncated: false,
          },
        ],
      },
    });
    expect(updated?.runtime.queueDepth).toBe(1);
    expect(updated?.queue).toEqual({
      revision: 1,
      messages: [
        {
          id: "queue-1",
          text: "Check the tests too",
          streamingBehavior: "followUp",
          imageCount: 0,
          truncated: false,
        },
      ],
    });
  });

  it("updates context usage with runtime state", () => {
    const updated = applySessionEvent(snapshot, {
      type: "runtime_updated",
      runtime: { ...snapshot.runtime, updatedAt: 2 },
      currentModel: null,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      contextUsage: { tokens: 25_000, contextWindow: 100_000, percent: 25 },
    });
    expect(updated?.contextUsage).toEqual({
      tokens: 25_000,
      contextWindow: 100_000,
      percent: 25,
    });
  });

  it("accounts small snapshot updates without serializing the full snapshot", () => {
    const event: ServerEvent = {
      type: "runtime_updated",
      runtime: { ...snapshot.runtime, updatedAt: 2 },
      currentModel: null,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      contextUsage: { tokens: 25_000, contextWindow: 100_000, percent: 25 },
    };
    const updated = applySessionEvent(snapshot, event);
    expect(updated).toBeDefined();

    const stringify = vi.spyOn(JSON, "stringify");
    updatedSnapshotBytes(10_000, snapshot, updated!, event, 0);
    expect(stringify.mock.calls.some(([value]) => value === updated)).toBe(false);
    expect(stringify.mock.calls.some(([value]) => value === updated?.transcript)).toBe(false);
    stringify.mockRestore();
  });

  it("applies transcript deltas without duplicating existing messages", () => {
    const updated = applySessionEvent(snapshot, {
      type: "transcript_delta",
      appended: [first, second],
      removedIds: [],
      notice: null,
      toolUpserts: {},
      removedToolIds: [],
      truncated: false,
    });
    expect(updated?.transcript.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("appends assistant and tool output deltas", () => {
    const streaming: SessionSnapshot = {
      ...snapshot,
      streamingMessage: {
        ...second,
        id: "live",
        blocks: [{ type: "text", text: "Hel" }],
        streaming: true,
      },
      tools: {
        tool: {
          id: "tool",
          name: "bash",
          arguments: { command: "test" },
          status: "running",
          output: "first",
        },
      },
    };
    const assistant = applySessionEvent(streaming, {
      type: "assistant_delta",
      messageId: "live",
      blockIndex: 0,
      field: "text",
      append: "lo",
    });
    expect(assistant?.streamingMessage?.blocks[0]).toEqual({ type: "text", text: "Hello" });

    const tool = applySessionEvent(assistant, {
      type: "tool_delta",
      toolId: "tool",
      outputAppend: " second",
      patchAppend: "+line",
    });
    expect(tool?.tools.tool).toMatchObject({ output: "first second", patch: "+line" });
  });
});
