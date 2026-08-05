import { describe, expect, it } from "vitest";

import {
  ArchiveSessionRequestSchema,
  MAX_IMAGE_ATTACHMENTS,
  MAX_PROMPT_BYTES,
  MarkSessionReadRequestSchema,
  ProtocolError,
  RenameSessionRequestSchema,
  UpdateSessionRequestSchema,
  isServerEnvelope,
  parseClientEnvelope,
  parseServerEnvelope,
} from "../src/shared/protocol.js";

function envelope(command: unknown, requestId = "request-1") {
  return JSON.stringify({ kind: "command", requestId, command });
}

describe("parseClientEnvelope", () => {
  it("accepts a typed prompt command", () => {
    expect(parseClientEnvelope(envelope({ type: "prompt", text: "hello\nworld" }))).toEqual({
      kind: "command",
      requestId: "request-1",
      command: { type: "prompt", text: "hello\nworld" },
    });
  });

  it("accepts image attachments and image-only prompts", () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    expect(
      parseClientEnvelope(envelope({ type: "prompt", text: "What is this?", images: [image] }))
        .command,
    ).toEqual({ type: "prompt", text: "What is this?", images: [image] });
    expect(
      parseClientEnvelope(envelope({ type: "prompt", text: "", images: [image] })).command,
    ).toEqual({ type: "prompt", text: "", images: [image] });
  });

  it("rejects malformed, unsupported, and excessive image attachments", () => {
    expect(() =>
      parseClientEnvelope(
        envelope({
          type: "prompt",
          text: "inspect",
          images: [{ type: "image", data: "not base64", mimeType: "image/png" }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_image" }));
    expect(() =>
      parseClientEnvelope(
        envelope({
          type: "prompt",
          text: "inspect",
          images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/svg+xml" }],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_image" }));
    expect(() =>
      parseClientEnvelope(
        envelope({
          type: "prompt",
          text: "inspect",
          images: Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, () => ({
            type: "image",
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          })),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "too_many_images" }));
  });

  it("accepts Pi's native steering and follow-up queue modes", () => {
    expect(
      parseClientEnvelope(
        envelope({ type: "prompt", text: "change direction", streamingBehavior: "steer" }),
      ).command,
    ).toEqual({ type: "prompt", text: "change direction", streamingBehavior: "steer" });
    expect(
      parseClientEnvelope(
        envelope({ type: "prompt", text: "do this afterward", streamingBehavior: "followUp" }),
      ).command,
    ).toEqual({ type: "prompt", text: "do this afterward", streamingBehavior: "followUp" });
    expect(() =>
      parseClientEnvelope(
        envelope({ type: "prompt", text: "not a mode", streamingBehavior: "later" }),
      ),
    ).toThrow("Invalid input");
  });

  it("accepts queue update, delete, and clear commands", () => {
    expect(
      parseClientEnvelope(
        envelope({
          type: "update_queued_message",
          messageId: "queue-1",
          queueRevision: 3,
          text: "revised",
          streamingBehavior: "followUp",
        }),
      ).command,
    ).toEqual({
      type: "update_queued_message",
      messageId: "queue-1",
      queueRevision: 3,
      text: "revised",
      streamingBehavior: "followUp",
    });
    expect(
      parseClientEnvelope(
        envelope({ type: "delete_queued_message", messageId: "queue-1", queueRevision: 3 }),
      ).command,
    ).toEqual({ type: "delete_queued_message", messageId: "queue-1", queueRevision: 3 });
    expect(
      parseClientEnvelope(envelope({ type: "clear_queued_messages", queueRevision: 3 })).command,
    ).toEqual({ type: "clear_queued_messages", queueRevision: 3 });
    expect(() =>
      parseClientEnvelope(
        envelope({ type: "delete_queued_message", messageId: "queue-1", queueRevision: -1 }),
      ),
    ).toThrow("Invalid input");
  });

  it("rejects malformed messages and invalid envelopes", () => {
    expect(() => parseClientEnvelope("not-json")).toThrowError(ProtocolError);
    expect(() => parseClientEnvelope(JSON.stringify({ kind: "event" }))).toThrow(
      "Expected a command envelope",
    );
  });

  it("rejects blank and oversized UTF-8 prompts", () => {
    expect(() => parseClientEnvelope(envelope({ type: "prompt", text: "   " }))).toThrow("blank");
    expect(() =>
      parseClientEnvelope(envelope({ type: "prompt", text: "😀".repeat(MAX_PROMPT_BYTES / 2) })),
    ).toThrow("byte limit");
  });

  it("validates request IDs and thinking levels", () => {
    expect(() => parseClientEnvelope(envelope({ type: "abort" }, "bad id"))).toThrow(
      "unsupported characters",
    );
    expect(() =>
      parseClientEnvelope(envelope({ type: "set_thinking_level", level: "extreme" })),
    ).toThrow("Unsupported thinking level");
  });

  it("validates session metadata updates", () => {
    expect(RenameSessionRequestSchema.parse({ name: "Release audit" })).toEqual({
      name: "Release audit",
    });
    expect(ArchiveSessionRequestSchema.parse({ archived: true })).toEqual({ archived: true });
    expect(MarkSessionReadRequestSchema.parse({ unread: false })).toEqual({ unread: false });
    expect(UpdateSessionRequestSchema.parse({ archived: false })).toEqual({ archived: false });
    expect(RenameSessionRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(RenameSessionRequestSchema.safeParse({ name: "😀".repeat(200) }).success).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({ archived: true, name: "Both" }).success).toBe(
      false,
    );
  });

  it("rejects server envelopes whose nested payload does not match the protocol", () => {
    const shallowOnly = {
      kind: "event",
      sessionId: "session",
      sequence: 1,
    };
    expect(isServerEnvelope(shallowOnly)).toBe(false);
    expect(() => parseServerEnvelope(JSON.stringify(shallowOnly))).toThrow(
      "Invalid server message",
    );
  });
});
