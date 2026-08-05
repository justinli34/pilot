import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { MAX_PAGE_SIZE, pageSize, projectPage, sessionPage } from "../src/server/pagination.js";
import type { Project } from "../src/server/project-service.js";

function project(id: string): Project {
  return { id, name: id, path: `/projects/${id}` };
}

function session(id: string, modifiedAt: number): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/projects/demo",
    created: new Date(0),
    modified: new Date(modifiedAt),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  };
}

describe("API pagination", () => {
  it("pages projects with an opaque cursor", () => {
    const projects = [project("alpha"), project("beta"), project("gamma")];
    const first = projectPage(projects, undefined, 2);
    expect(first.items.map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(first.nextCursor).toBeDefined();

    const second = projectPage(projects, first.nextCursor, 2);
    expect(second.items.map((item) => item.id)).toEqual(["gamma"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("uses a stable session sort key for the next page", () => {
    const sessions = [session("alpha", 3), session("beta", 2), session("gamma", 1)];
    const first = sessionPage(sessions, undefined, 2);
    expect(first.items.map((item) => item.id)).toEqual(["alpha", "beta"]);

    const second = sessionPage(sessions, first.nextCursor, 2);
    expect(second.items.map((item) => item.id)).toEqual(["gamma"]);
  });

  it("rejects invalid cursors and page sizes", () => {
    expect(() => projectPage([], "not-a-cursor", 10)).toThrow("cursor");
    expect(() => pageSize("0")).toThrow("between");
    expect(() => pageSize(String(MAX_PAGE_SIZE + 1))).toThrow("between");
  });
});
