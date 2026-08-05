import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { Project } from "../src/server/project-service.js";
import {
  RuntimeRegistry,
  type RuntimeHandle,
  type RuntimeHostFactory,
} from "../src/server/runtime-registry.js";
import type { SessionStatus } from "../src/shared/protocol.js";

const project: Project = {
  id: "project-id",
  name: "project",
  path: "/tmp/project",
};
const info: SessionInfo = {
  path: "/tmp/session.jsonl",
  id: "session-1234",
  cwd: project.path,
  created: new Date(0),
  modified: new Date(0),
  messageCount: 0,
  firstMessage: "",
  allMessagesText: "",
};

const catalogMutations = {
  refreshSession: async (_project: Project, session: SessionInfo) => ({
    ...session,
    archived: false,
  }),
  renameSession: async (_project: Project, session: SessionInfo, name: string) => ({
    ...session,
    name,
    archived: false,
  }),
  setSessionArchived: async (_project: Project, session: SessionInfo, archived: boolean) => ({
    ...session,
    archived,
  }),
  deleteSession: async () => {},
};

const idleHostCapabilities = {
  isIdle: true as const,
  renameSession: () => {},
  setSessionArchived: () => {},
};

describe("RuntimeRegistry", () => {
  it("single-flights concurrent opens of the same session", async () => {
    const app = Fastify({ logger: false });
    const manager = SessionManager.inMemory(project.path, { id: info.id });
    const catalog = {
      agentDir: "/tmp/agent",
      open: () => manager,
      create: async () => manager,
      ...catalogMutations,
    };
    let creations = 0;
    let runtimeChanged: (() => void) | undefined;
    const createHost: RuntimeHostFactory = async (options) => {
      creations += 1;
      runtimeChanged = options.onRuntimeChange;
      await Promise.resolve();
      return {
        sessionId: info.id,
        project,
        lastActivity: Date.now(),
        status: () => ({ status: "idle", phase: "idle" }),
        estimatedSize: () => 1,
        canDispose: () => false,
        ...idleHostCapabilities,
        attach: () => {},
        dispose: async () => {},
      } satisfies RuntimeHandle;
    };
    const registry = new RuntimeRegistry(catalog, 60_000, 1, 32 * 1024 * 1024, app.log, createHost);
    let updates = 0;
    const unsubscribe = registry.subscribe(project.id, () => {
      updates += 1;
    });

    const [first, second] = await Promise.all([
      registry.open(project, info),
      registry.open(project, info),
    ]);
    expect(first).toBe(second);
    expect(creations).toBe(1);
    expect(updates).toBe(1);
    runtimeChanged?.();
    expect(updates).toBe(2);

    unsubscribe();
    await registry.disposeAll();
    await app.close();
  });

  it("tracks unread completions without a browser subscription", async () => {
    const app = Fastify({ logger: false });
    const manager = SessionManager.inMemory(project.path, { id: info.id });
    const catalog = {
      agentDir: "/tmp/agent",
      open: () => manager,
      create: async () => manager,
      ...catalogMutations,
    };
    let status: SessionStatus = "idle";
    let runtimeChanged: (() => void) | undefined;
    const createHost: RuntimeHostFactory = async (options) => {
      runtimeChanged = options.onRuntimeChange;
      return {
        sessionId: info.id,
        project,
        lastActivity: Date.now(),
        status: () => ({ status, phase: status }),
        estimatedSize: () => 1,
        canDispose: () => false,
        ...idleHostCapabilities,
        attach: () => {},
        dispose: async () => {},
      } satisfies RuntimeHandle;
    };
    const registry = new RuntimeRegistry(catalog, 60_000, 1, 32 * 1024 * 1024, app.log, createHost);
    await registry.open(project, info);

    status = "running";
    runtimeChanged?.();
    expect(registry.isUnread(info.id)).toBe(false);
    status = "idle";
    runtimeChanged?.();
    expect(registry.isUnread(info.id)).toBe(true);

    registry.markSessionRead(project.id, info.id);
    expect(registry.isUnread(info.id)).toBe(false);

    await registry.disposeAll();
    await app.close();
  });

  it("refuses to delete a running runtime", async () => {
    const app = Fastify({ logger: false });
    const manager = SessionManager.inMemory(project.path, { id: info.id });
    let deleted = false;
    let archived = false;
    const catalog = {
      agentDir: "/tmp/agent",
      open: () => manager,
      create: async () => manager,
      ...catalogMutations,
      setSessionArchived: async () => {
        archived = true;
        return { ...info, archived: true };
      },
      deleteSession: async () => {
        deleted = true;
      },
    };
    const createHost: RuntimeHostFactory = async () => ({
      sessionId: info.id,
      project,
      lastActivity: Date.now(),
      status: () => ({ status: "running", phase: "running" }),
      estimatedSize: () => 1,
      canDispose: () => false,
      isIdle: false,
      renameSession: () => {},
      setSessionArchived: () => {},
      attach: () => {},
      dispose: async () => {},
    });
    const registry = new RuntimeRegistry(catalog, 60_000, 2, 1024, app.log, createHost);
    await registry.open(project, info);

    await expect(registry.setSessionArchived(project, info, true)).rejects.toMatchObject({
      code: "session_busy",
    });
    await expect(registry.deleteSession(project, info)).rejects.toMatchObject({
      code: "session_busy",
    });
    expect(archived).toBe(false);
    expect(deleted).toBe(false);

    await registry.disposeAll();
    await app.close();
  });

  it("evicts the least-recently-used idle runtime at the configured capacity", async () => {
    const app = Fastify({ logger: false });
    const disposed: string[] = [];
    const catalog = {
      agentDir: "/tmp/agent",
      open: (_project: Project, session: SessionInfo) =>
        SessionManager.inMemory(project.path, { id: session.id }),
      create: async () => SessionManager.inMemory(project.path),
      ...catalogMutations,
    };
    const createHost: RuntimeHostFactory = async (options) => {
      const sessionId = options.manager.getSessionId();
      return {
        sessionId,
        project,
        lastActivity: sessionId.endsWith("1") ? 1 : 2,
        status: () => ({ status: "idle", phase: "idle" }),
        estimatedSize: () => 1,
        canDispose: () => true,
        ...idleHostCapabilities,
        attach: () => {},
        dispose: async () => {
          disposed.push(sessionId);
        },
      } satisfies RuntimeHandle;
    };
    const registry = new RuntimeRegistry(catalog, 60_000, 1, 1024, app.log, createHost);
    const firstInfo = { ...info, id: "session-0001" };
    const secondInfo = { ...info, id: "session-0002" };

    await registry.open(project, firstInfo);
    await registry.open(project, secondInfo);

    expect(disposed).toContain(firstInfo.id);
    await registry.disposeAll();
    await app.close();
  });
});
