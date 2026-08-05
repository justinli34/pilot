import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { SessionView } from "../src/server/session-view.js";
import { projectAssistantMessage } from "../src/server/transcript.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("transcript projection", () => {
  it("projects valid user image attachments for the browser", () => {
    const manager = SessionManager.inMemory("/tmp/project");
    const image = {
      type: "image" as const,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
      mimeType: "image/png",
    } as const;
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Inspect this" }, image],
      timestamp: 1,
    });

    expect(new SessionView(manager, false).snapshot().transcript[0]).toMatchObject({
      kind: "message",
      role: "user",
      blocks: [{ type: "text", text: "Inspect this" }, image],
    });
  });

  it("removes blank lines and empty blocks from thinking content", () => {
    const message = projectAssistantMessage(
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "**First**\r\n \r\n**Second**\n\n\n**Third**",
          },
          { type: "thinking", thinking: " \n\t\n " },
        ],
      },
      "live",
    );

    expect(message?.blocks).toEqual([
      { type: "thinking", thinking: "**First**\n**Second**\n**Third**" },
    ]);
  });

  it("reconstructs assistant blocks and completed edit cards from persisted entries", () => {
    const manager = SessionManager.inMemory("/tmp/project");
    manager.appendMessage({ role: "user", content: "change it", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "I will edit it." },
        {
          type: "toolCall",
          id: "call-1",
          name: "edit",
          arguments: { path: "a.ts", apiKey: "secret" },
        },
      ],
      api: "test",
      provider: "test",
      model: "model",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "edit",
      content: [{ type: "text", text: "updated" }],
      details: { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" },
      isError: false,
      timestamp: 3,
    });

    const result = new SessionView(manager, false).snapshot();
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[1]).toMatchObject({
      kind: "message",
      role: "assistant",
      timestamp: 2,
      completedAt: expect.any(Number),
    });
    expect(result.tools["call-1"]).toMatchObject({ status: "succeeded", output: "updated" });
    expect(result.tools["call-1"]?.patch).toContain("+++ b/a.ts");
    expect(result.tools["call-1"]?.arguments).toEqual({ path: "a.ts", apiKey: "[REDACTED]" });
  });
});
