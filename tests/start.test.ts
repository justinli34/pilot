import { describe, expect, it } from "vitest";

import { startupInstructions } from "../src/server/start.js";

describe("server startup output", () => {
  it("shows the port, browser address, log file, and quit instruction", () => {
    expect(
      startupInstructions({
        host: "127.0.0.1",
        port: 4321,
        logFile: "/home/ada/.local/state/pilot/pilot.log",
      }),
    ).toBe(
      [
        "Pilot is running at http://127.0.0.1:4321.",
        "Logs: /home/ada/.local/state/pilot/pilot.log",
        "Press Ctrl+C to quit.",
      ].join("\n"),
    );
  });
});
