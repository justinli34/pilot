import { describe, expect, it } from "vitest";

import { shouldReconnect } from "../src/client/use-session-socket.js";
import { sessionOpenCloseCode } from "../src/server/app.js";
import { AppError } from "../src/server/errors.js";

describe("session reconnect policy", () => {
  it("retries server failures and stops only for permanent policy failures", () => {
    expect(sessionOpenCloseCode(new Error("temporary failure"))).toBe(1011);
    expect(sessionOpenCloseCode(new AppError(503, "unavailable", "try later"))).toBe(1011);
    expect(sessionOpenCloseCode(new AppError(404, "missing", "not found"))).toBe(1008);
    expect(shouldReconnect(1011)).toBe(true);
    expect(shouldReconnect(1012)).toBe(true);
    expect(shouldReconnect(1008)).toBe(false);
  });
});
