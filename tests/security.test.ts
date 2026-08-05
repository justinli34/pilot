import { describe, expect, it } from "vitest";

import { redactText, sanitizeJson, truncateUtf8 } from "../src/server/security.js";

describe("security projection", () => {
  it("redacts common credentials in text and structured data", () => {
    const redacted = redactText(
      'apiKey: "sk-abcdefghijklmnop" Bearer abcdefghijklmnop "access":"oauth-value-123456"',
    );
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("oauth-value-123456");
    expect(redactText('"key":"plain-provider-secret"')).not.toContain("plain-provider-secret");
    expect(sanitizeJson({ nested: { password: "hunter2", safe: "visible" } })).toEqual({
      nested: { password: "[REDACTED]", safe: "visible" },
    });
  });

  it("truncates on a valid UTF-8 boundary", () => {
    const result = truncateUtf8("😀".repeat(100), 40, "…");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(40);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("�");
  });
});
