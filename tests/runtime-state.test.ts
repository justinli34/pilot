import { describe, expect, it } from "vitest";

import { RuntimeStateTracker } from "../src/server/runtime-state.js";

describe("RuntimeStateTracker", () => {
  it("derives phases from Pi state and explicit local operations", () => {
    const tracker = new RuntimeStateTracker();
    const session = { isIdle: true, isCompacting: false };
    expect(tracker.snapshot(session)).toMatchObject({ phase: "idle", status: "idle" });

    tracker.setQueueDepth(2);
    expect(tracker.snapshot(session).queueDepth).toBe(2);
    tracker.setQueueDepth(0);

    const modelChange = tracker.begin("set-model");
    expect(tracker.isIdle(session)).toBe(false);
    expect(tracker.snapshot(session)).toMatchObject({
      phase: "idle",
      status: "idle",
      isBusy: false,
    });
    tracker.end(modelChange);

    session.isCompacting = true;
    expect(tracker.snapshot(session).phase).toBe("compacting");
    session.isCompacting = false;

    tracker.startRetry(
      { attempt: 1, maxAttempts: 3, delayMs: 500 },
      { action: "Automatic retry", message: "temporary", at: 1 },
    );
    session.isIdle = false;
    expect(tracker.snapshot(session)).toMatchObject({ phase: "retrying", status: "running" });

    const abort = tracker.begin("abort");
    expect(tracker.snapshot(session).phase).toBe("aborting");
    tracker.end(abort);
    tracker.endRetry();
    session.isIdle = true;
    expect(tracker.snapshot(session)).toMatchObject({ phase: "error", status: "error" });

    tracker.clearError();
    expect(tracker.snapshot(session)).toMatchObject({ phase: "idle", status: "idle" });
  });
});
