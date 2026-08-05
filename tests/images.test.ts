import { describe, expect, it } from "vitest";

import { safeImageAttachment, validateImageAttachments } from "../src/server/images.js";
import { detectImageMediaType } from "../src/shared/images.js";

const png = {
  type: "image" as const,
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
  mimeType: "image/png" as const,
};

describe("image validation", () => {
  it("detects supported image signatures", () => {
    expect(detectImageMediaType(Buffer.from(png.data, "base64"))).toBe("image/png");
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(detectImageMediaType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectImageMediaType(Buffer.from("RIFF\0\0\0\0WEBP"))).toBe("image/webp");
  });

  it("accepts safe image data and rejects media-type spoofing", () => {
    expect(safeImageAttachment(png)).toEqual(png);
    expect(safeImageAttachment({ ...png, mimeType: "image/jpeg" })).toBeUndefined();
    expect(() => validateImageAttachments([{ ...png, mimeType: "image/jpeg" }])).toThrowError(
      expect.objectContaining({ code: "invalid_image" }),
    );
  });
});
