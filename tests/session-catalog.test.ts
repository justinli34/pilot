import { appendFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "../src/server/project-service.js";
import { SessionCatalog } from "../src/server/session-catalog.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for catalog update");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("SessionCatalog", () => {
  it("persists and discovers a new session before its first assistant response", async () => {
    const base = await mkdtemp(join(tmpdir(), "pilot-session-catalog-"));
    const projectPath = join(base, "project");
    const sessionDir = join(base, "sessions");
    await mkdir(projectPath);

    const app = Fastify({ logger: false });
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    cleanup.push(async () => {
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      await app.close();
      await rm(base, { recursive: true, force: true });
    });

    const project: Project = {
      id: "project-id",
      name: "project",
      path: projectPath,
    };
    const catalog = new SessionCatalog(app.log);
    const manager = await catalog.create(project);
    const sessionFile = manager.getSessionFile();

    expect(sessionFile).toBeDefined();
    expect((await catalog.list(project)).sessions.map((session) => session.id)).toContain(
      manager.getSessionId(),
    );

    manager.appendThinkingLevelChange("off");
    const lines = (await readFile(sessionFile!, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!).type).toBe("session");
    expect(JSON.parse(lines[1]!).type).toBe("thinking_level_change");

    const uncachedProject = { ...project, id: "uncached-project" };
    const firstList = catalog.list(uncachedProject);
    const concurrentList = catalog.list(uncachedProject);
    expect(firstList).toBe(concurrentList);
    await firstList;
  });

  it("stores archive state in Pi custom entries and uses the latest value", async () => {
    const base = await mkdtemp(join(tmpdir(), "pilot-session-archive-"));
    const projectPath = join(base, "project");
    const sessionDir = join(base, "sessions");
    await mkdir(projectPath);

    const app = Fastify({ logger: false });
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const catalog = new SessionCatalog(app.log);
    cleanup.push(async () => {
      catalog.close();
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      await app.close();
      await rm(base, { recursive: true, force: true });
    });

    const project: Project = {
      id: "project-archive",
      name: "project",
      path: projectPath,
    };
    const manager = await catalog.create(project);
    const initial = await catalog.find(project, manager.getSessionId());
    expect(initial.archived).toBe(false);

    const archived = await catalog.setSessionArchived(project, initial, true);
    expect(archived.archived).toBe(true);
    const restored = await catalog.setSessionArchived(project, archived, false);
    expect(restored.archived).toBe(false);

    const contents = await readFile(restored.path, "utf8");
    expect(contents.match(/"customType":"pilot.session-state"/g)).toHaveLength(2);
  });

  it("updates one changed file and suppresses tool-only list notifications", async () => {
    const base = await mkdtemp(join(tmpdir(), "pilot-session-incremental-"));
    const projectPath = join(base, "project");
    const sessionDir = join(base, "sessions");
    await mkdir(projectPath);

    const app = Fastify({ logger: false });
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const catalog = new SessionCatalog(app.log);
    cleanup.push(async () => {
      catalog.close();
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      await app.close();
      await rm(base, { recursive: true, force: true });
    });

    const project: Project = {
      id: "project-incremental",
      name: "project",
      path: projectPath,
    };
    const manager = await catalog.create(project);
    const file = manager.getSessionFile();
    if (!file) throw new Error("Expected a session file");
    let notifications = 0;
    await catalog.subscribe(project, () => {
      notifications += 1;
    });
    await catalog.list(project);

    await appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        id: "tool-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "tool",
          toolName: "bash",
          content: [{ type: "text", text: "output" }],
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(notifications).toBe(0);
    expect((await catalog.list(project)).sessions[0]?.messageCount).toBe(1);

    await appendFile(
      file,
      `${JSON.stringify({
        type: "message",
        id: "assistant-entry",
        parentId: "tool-entry",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: Date.now() + 1_000,
        },
      })}\n`,
    );
    await waitFor(() => notifications === 1);
    expect((await catalog.list(project)).sessions[0]?.messageCount).toBe(2);
  });
});
