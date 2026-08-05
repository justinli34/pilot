const SENSITIVE_KEY =
  /(?:api[-_]?key|authorization|password|passwd|secret|access(?:[-_]?token)?|refresh(?:[-_]?token)?|^token$|^key$|cookie|credential|private[-_]?key)/i;
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
];
const SECRET_ASSIGNMENT =
  /(["']?(?:api[-_]?key|authorization|password|passwd|secret|access(?:[-_]?token)?|refresh(?:[-_]?token)?|token|key|private[-_]?key)["']?\s*[:=]\s*["']?)([^\s,"'}]{4,})/gi;

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  marker = "\n… [truncated by Pilot]",
): string {
  const safe = redactText(value);
  if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const buffer = Buffer.from(safe, "utf8");
  let end = Math.min(buffer.length, budget);
  while (end > 0 && (buffer[end] ?? 0) >> 6 === 0b10) end--;
  return `${buffer.subarray(0, end).toString("utf8")}${marker}`;
}

type SafeJson = import("../shared/protocol.js").JsonValue;

function sanitizeJsonValue(
  value: unknown,
  maxStringBytes: number,
  budget: { nodes: number },
  depth: number,
): SafeJson {
  budget.nodes--;
  if (budget.nodes < 0) return "[structured value truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value as number) || typeof value !== "number"
      ? (value as null | boolean | number)
      : String(value);
  }
  if (typeof value === "string") return truncateUtf8(value, maxStringBytes);
  if (depth >= 8) return "[maximum depth reached]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((entry) => sanitizeJsonValue(entry, maxStringBytes, budget, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, SafeJson> = Object.create(null) as Record<string, SafeJson>;
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeJsonValue(entry, maxStringBytes, budget, depth + 1);
    }
    return output;
  }
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  return "[function]";
}

export function sanitizeJson(value: unknown, maxStringBytes = 64 * 1024): SafeJson {
  const projected = sanitizeJsonValue(value, maxStringBytes, { nodes: 2_000 }, 0);
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 256 * 1024) {
    return "[structured value omitted: exceeded 256 KiB browser limit]";
  }
  return projected;
}

export function safeLogMessage(error: unknown, maxBytes = 2_048): string {
  const value = error instanceof Error ? error.message : String(error);
  return truncateUtf8(value, maxBytes, "…");
}
