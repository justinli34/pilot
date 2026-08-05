import { describe, expect, it } from "vitest";

import { groupTranscriptSections } from "../src/client/transcript-sections.js";
import type { TranscriptItem, TranscriptMessage } from "../src/shared/protocol.js";

function message(
  id: string,
  role: TranscriptMessage["role"],
  blocks: TranscriptMessage["blocks"],
  streaming = false,
): TranscriptMessage {
  return {
    kind: "message",
    id,
    role,
    blocks,
    timestamp: 1,
    ...(streaming ? { streaming: true } : {}),
  };
}

describe("transcript sections", () => {
  it("groups an assistant's tool loop into one section", () => {
    const user = message("user-1", "user", [{ type: "text", text: "Fix it" }]);
    const first = message("assistant-1", "assistant", [
      { type: "thinking", thinking: "Inspect the file" },
      { type: "tool_call", toolCallId: "tool-1", name: "read", arguments: {} },
    ]);
    const second = message("assistant-2", "assistant", [
      { type: "thinking", thinking: "Apply the change" },
      { type: "tool_call", toolCallId: "tool-2", name: "edit", arguments: {} },
    ]);
    const final = message("assistant-3", "assistant", [{ type: "text", text: "Done" }]);

    const sections = groupTranscriptSections([user, first, second, final], null);

    expect(sections).toHaveLength(2);
    expect(sections[1]).toMatchObject({
      kind: "messages",
      role: "assistant",
      messages: [first, second, final],
      turnStartedAt: user.timestamp,
    });
  });

  it("adds the next streaming response to the current assistant section", () => {
    const persisted = message("assistant-1", "assistant", [
      { type: "tool_call", toolCallId: "tool-1", name: "read", arguments: {} },
    ]);
    const streaming = message(
      "live-2",
      "assistant",
      [{ type: "thinking", thinking: "Reviewing the result" }],
      true,
    );

    const sections = groupTranscriptSections([persisted], streaming);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ messages: [persisted, streaming] });
  });

  it("starts a new assistant section after the next user message", () => {
    const transcript: TranscriptItem[] = [
      message("assistant-1", "assistant", [{ type: "text", text: "First response" }]),
      message("user-2", "user", [{ type: "text", text: "One more thing" }]),
      message("assistant-2", "assistant", [{ type: "text", text: "Second response" }]),
    ];

    const sections = groupTranscriptSections(transcript, null);

    expect(sections.map((section) => section.kind)).toEqual(["messages", "messages", "messages"]);
    expect(sections.map((section) => section.id)).toEqual(["assistant-1", "user-2", "assistant-2"]);
  });
});
