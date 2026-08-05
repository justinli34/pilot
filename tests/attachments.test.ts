import { describe, expect, it } from "vitest";

import {
  MAX_TEXT_FILE_BYTES,
  appendTextAttachments,
  readPendingAttachment,
  type PendingTextAttachment,
} from "../src/client/attachment-upload.js";

function textAttachment(text: string, name = "example.ts"): PendingTextAttachment {
  return {
    type: "text-file",
    id: "attachment-1",
    name,
    bytes: new TextEncoder().encode(text).byteLength,
    text,
  };
}

describe("file attachments", () => {
  it("reads UTF-8 text and extensionless code files", async () => {
    const attachment = await readPendingAttachment(new File(["FROM node:24\n"], "Dockerfile"));

    expect(attachment).toMatchObject({
      type: "text-file",
      name: "Dockerfile",
      text: "FROM node:24\n",
      bytes: 13,
    });
  });

  it("detects supported images by signature", async () => {
    const attachment = await readPendingAttachment(
      new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "upload.bin"),
    );

    expect(attachment).toMatchObject({
      type: "image",
      name: "upload.bin",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
  });

  it("rejects binary, invalid UTF-8, and oversized text files", async () => {
    await expect(
      readPendingAttachment(new File([Uint8Array.from([0, 1, 2])], "data.bin")),
    ).rejects.toThrow("not a UTF-8 text or supported image file");
    await expect(
      readPendingAttachment(new File([Uint8Array.from([0xff, 0xfe])], "data.txt")),
    ).rejects.toThrow("not a UTF-8 text or supported image file");
    await expect(
      readPendingAttachment(new File(["x".repeat(MAX_TEXT_FILE_BYTES + 1)], "large.ts")),
    ).rejects.toThrow("larger than 64 KiB");
  });

  it("labels files and safely expands code fences in the prompt", () => {
    const prompt = appendTextAttachments("Review this implementation.", [
      textAttachment("const fence = '```';\n", "fence.ts"),
    ]);

    expect(prompt).toContain('Attached file "fence.ts":');
    expect(prompt).toContain("````\nconst fence = '```';\n````");
    expect(prompt.startsWith("Review this implementation.\n\n")).toBe(true);
  });
});
