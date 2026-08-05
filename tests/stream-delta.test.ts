import { describe, expect, it } from "vitest";

import { createAssistantDelta, createToolDelta } from "../src/server/stream-delta.js";
import type { ToolExecution, TranscriptMessage } from "../src/shared/protocol.js";

function assistant(text: string): TranscriptMessage {
  return {
    kind: "message",
    id: "live",
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: 1,
    streaming: true,
  };
}

function tool(output: string, status: ToolExecution["status"] = "running"): ToolExecution {
  return {
    id: "tool",
    name: "bash",
    arguments: { command: "test" },
    status,
    output,
    startedAt: 1,
  };
}

describe("stream deltas", () => {
  it("sends only an appended assistant suffix", () => {
    expect(createAssistantDelta(assistant("hello"), assistant("hello world"))).toEqual({
      type: "assistant_delta",
      messageId: "live",
      blockIndex: 0,
      field: "text",
      append: " world",
    });
    expect(createAssistantDelta(assistant("secret"), assistant("[REDACTED]"))).toBeUndefined();
  });

  it("sends only appended tool output while metadata is stable", () => {
    expect(createToolDelta(tool("one"), tool("one two"))).toEqual({
      type: "tool_delta",
      toolId: "tool",
      outputAppend: " two",
    });
    expect(createToolDelta(tool("one"), tool("one two", "succeeded"))).toBeUndefined();
  });
});
