import { describe, expect, it } from "vitest";

import { NativeMessageQueue } from "../src/server/message-queue.js";
import {
  MAX_PROMPT_BYTES,
  type ImageAttachment,
  type MessageQueueState,
} from "../src/shared/protocol.js";

class FakePiQueue {
  steering: string[] = [];
  followUps: string[] = [];
  steeringImages: ImageAttachment[][] = [];
  followUpImages: ImageAttachment[][] = [];
  rejectText?: string;

  getSteeringMessages(): readonly string[] {
    return this.steering;
  }

  getFollowUpMessages(): readonly string[] {
    return this.followUps;
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = { steering: [...this.steering], followUp: [...this.followUps] };
    this.steering = [];
    this.followUps = [];
    this.steeringImages = [];
    this.followUpImages = [];
    return cleared;
  }

  async steer(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (text === this.rejectText) throw new Error("rejected queued text");
    this.steering.push(text);
    this.steeringImages.push(images);
  }

  async followUp(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (text === this.rejectText) throw new Error("rejected queued text");
    this.followUps.push(text);
    this.followUpImages.push(images);
  }
}

function setup() {
  const session = new FakePiQueue();
  const changes: MessageQueueState[] = [];
  const restoreErrors: unknown[] = [];
  const queue = new NativeMessageQueue({
    session,
    onChange: (state) => changes.push(state),
    onRestoreError: (error) => restoreErrors.push(error),
  });
  return { session, changes, restoreErrors, queue };
}

describe("NativeMessageQueue", () => {
  it("keeps stable IDs as Pi appends and drains native queue messages", () => {
    const { session, queue } = setup();
    session.steering.push("same", "same");
    queue.handleNativeUpdate(session.steering, session.followUps);
    const initial = queue.snapshot();
    expect(initial.messages).toHaveLength(2);

    session.steering.shift();
    queue.handleNativeUpdate(session.steering, session.followUps);
    expect(queue.snapshot().messages).toEqual([
      expect.objectContaining({ id: initial.messages[1]?.id, text: "same" }),
    ]);
  });

  it("redacts and bounds queue previews sent to the browser", () => {
    const { session, queue } = setup();
    session.steering.push("api_key=sk-super-secret-value", "x".repeat(MAX_PROMPT_BYTES + 100));
    queue.handleNativeUpdate(session.steering, session.followUps);
    const [secret, oversized] = queue.snapshot().messages;
    expect(secret?.text).toContain("[REDACTED]");
    expect(secret?.text).not.toContain("super-secret");
    expect(oversized?.truncated).toBe(true);
    expect(new TextEncoder().encode(oversized?.text).byteLength).toBeLessThanOrEqual(
      MAX_PROMPT_BYTES,
    );
  });

  it("tracks and preserves image attachments without exposing their data in snapshots", async () => {
    const { session, queue } = setup();
    const image: ImageAttachment = {
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    };
    const release = queue.reserveImages("", "steer", [image]);
    session.steering.push("");
    queue.handleNativeUpdate(session.steering, session.followUps);
    release();

    const queued = queue.snapshot().messages[0];
    expect(queued).toMatchObject({ text: "", imageCount: 1 });
    expect(JSON.stringify(queued)).not.toContain(image.data);
    if (!queued) throw new Error("Expected an image message");

    await queue.update(queued.id, queue.snapshot().revision, "inspect this", "followUp");
    expect(session.followUps).toEqual(["inspect this"]);
    expect(session.followUpImages).toEqual([[image]]);
  });

  it("updates delivery, deletes individual messages, and clears the queue", async () => {
    const { session, queue } = setup();
    session.steering.push("first");
    session.followUps.push("second");
    queue.handleNativeUpdate(session.steering, session.followUps);

    const first = queue.snapshot().messages[0];
    if (!first) throw new Error("Expected a queued message");
    await queue.update(first.id, queue.snapshot().revision, "revised", "followUp");
    expect(
      queue.snapshot().messages.map(({ text, streamingBehavior }) => ({
        text,
        streamingBehavior,
      })),
    ).toEqual([
      { text: "revised", streamingBehavior: "followUp" },
      { text: "second", streamingBehavior: "followUp" },
    ]);

    const second = queue.snapshot().messages[1];
    if (!second) throw new Error("Expected a second queued message");
    await queue.delete(second.id, queue.snapshot().revision);
    expect(queue.snapshot().messages.map((message) => message.text)).toEqual(["revised"]);

    await queue.clear(queue.snapshot().revision);
    expect(queue.snapshot().messages).toEqual([]);
    expect(session.steering).toEqual([]);
    expect(session.followUps).toEqual([]);
  });

  it("rejects stale changes and restores the native queue after invalid edits", async () => {
    const { session, queue, restoreErrors } = setup();
    session.steering.push("keep me");
    queue.handleNativeUpdate(session.steering, session.followUps);
    const original = queue.snapshot();
    const message = original.messages[0];
    if (!message) throw new Error("Expected a queued message");

    await expect(queue.delete(message.id, original.revision - 1)).rejects.toThrow("queue changed");

    session.rejectText = "invalid";
    await expect(queue.update(message.id, original.revision, "invalid", "steer")).rejects.toThrow(
      "rejected queued text",
    );
    expect(queue.snapshot().messages.map((item) => item.text)).toEqual(["keep me"]);
    expect(session.steering).toEqual(["keep me"]);
    expect(restoreErrors).toEqual([]);
  });
});
