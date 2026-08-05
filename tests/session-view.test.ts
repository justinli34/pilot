import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { SessionView } from "../src/server/session-view.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("SessionView", () => {
  it("projects appended entries as deltas and bounds retained tool state", () => {
    const manager = SessionManager.inMemory("/tmp/project");
    const view = new SessionView(manager, false);

    const userId = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const first = view.sync(true);
    expect(first).toMatchObject({ type: "delta", appended: [{ id: userId }] });

    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "edit",
          arguments: { path: "a.ts" },
        },
      ],
      api: "test",
      provider: "test",
      model: "model",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    expect(view.sync(true)).toMatchObject({
      type: "delta",
      toolUpserts: { "call-1": { status: "running" } },
    });

    view.updateTool({
      id: "call-1",
      name: "edit",
      arguments: { path: "a.ts" },
      status: "succeeded",
      output: "updated",
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "edit",
      content: [{ type: "text", text: "updated" }],
      isError: false,
      timestamp: 3,
    });
    expect(view.sync(true)).toMatchObject({
      type: "delta",
      toolUpserts: { "call-1": { status: "succeeded", output: "updated" } },
    });

    const largeMessage = "x".repeat(300 * 1024);
    for (let index = 0; index < 18; index++) {
      manager.appendMessage({ role: "user", content: largeMessage, timestamp: 10 + index });
    }
    const trimmed = view.sync(false);
    expect(trimmed).toMatchObject({ type: "delta", truncated: true });
    if (trimmed?.type !== "delta") throw new Error("Expected an incremental update");
    expect(trimmed.removedToolIds).toContain("call-1");
    expect(view.snapshot().tools["call-1"]).toBeUndefined();
    expect(view.snapshot().transcript[0]?.id).toBe("pilot-transcript-limit");
  });
});
