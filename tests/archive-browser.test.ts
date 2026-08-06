import { describe, expect, it } from "vitest";

import { groupArchivedSessions } from "../src/client/components/ArchiveBrowserDialog.js";
import { createdAtLabel, relativeDate } from "../src/client/components/SidebarSessionRow.js";
import type { ProjectSummary, SessionSummary } from "../src/shared/protocol.js";

const projects: ProjectSummary[] = [
  { id: "blue", name: "Bluebird", path: "/work/bluebird" },
  { id: "red", name: "Redwood", path: "/work/redwood" },
];

function session(id: string, projectId: string, archived: boolean, name: string): SessionSummary {
  return {
    id,
    projectId,
    name,
    firstMessage: `First message for ${name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 2,
    archived,
    unread: false,
    status: "idle",
    phase: "idle",
  };
}

describe("session dates", () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");

  it("uses compact relative dates", () => {
    expect(relativeDate("2026-08-04T12:00:00.000Z", now)).toBe("1d");
    expect(relativeDate("2026-08-05T10:00:00.000Z", now)).toBe("2h");
    expect(relativeDate("2026-08-05T11:59:30.000Z", now)).toBe("now");
    expect(relativeDate("2026-07-05T12:00:00.000Z", now)).toBe("1mo");
  });

  it("formats recent dates without an awkward ago suffix", () => {
    expect(createdAtLabel("now")).toBe("Created just now");
    expect(createdAtLabel("1d")).toBe("Created 1d ago");
  });
});

describe("archived session groups", () => {
  const sessions = [
    session("active-blue", "blue", false, "Active Blue"),
    session("archived-red", "red", true, "Archived Red"),
    session("archived-blue", "blue", true, "Archived Blue"),
  ];

  it("includes only archived sessions and preserves project organization", () => {
    expect(groupArchivedSessions(projects, sessions, "")).toEqual([
      { project: projects[0], sessions: [sessions[2]] },
      { project: projects[1], sessions: [sessions[1]] },
    ]);
  });

  it("searches archived sessions using their project context", () => {
    expect(groupArchivedSessions(projects, sessions, "bluebird")).toEqual([
      { project: projects[0], sessions: [sessions[2]] },
    ]);
  });
});
