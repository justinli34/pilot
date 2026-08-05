import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { RawData } from "ws";

import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import {
  parseWorkspaceSessionsStreamEnvelope,
  type WorkspaceSessionsStreamEnvelope,
} from "../src/shared/protocol.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setupFixture(withClient = false, logLevel: AppConfig["logLevel"] = "silent") {
  const root = await mkdtemp(join(tmpdir(), "pilot-app-"));
  const projectPath = join(root, "demo");
  const sessionDir = join(root, "sessions");
  await mkdir(join(projectPath, ".pi"), { recursive: true });
  await mkdir(sessionDir);
  await writeFile(join(projectPath, ".pi", "settings.json"), JSON.stringify({ sessionDir }));
  const clientDist = join(root, "client");
  if (withClient) {
    await mkdir(join(clientDist, "assets"), { recursive: true });
    await writeFile(join(clientDist, "index.html"), "<main>Pilot</main>");
    await writeFile(join(clientDist, "manifest.webmanifest"), JSON.stringify({ name: "Pilot" }));
    await writeFile(join(clientDist, "sw.js"), "self.addEventListener('fetch', () => {});");
    const asset = "export const ready = true;";
    await writeFile(join(clientDist, "assets", "app.js"), asset);
    await writeFile(join(clientDist, "assets", "app.js.br"), brotliCompressSync(asset));
  }
  const logFile = join(root, "logs", "pilot.log");
  const configPath = join(root, "config.json");
  const projectsPath = join(root, "projects.json");
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3210,
    projectsPath,
    allowedOrigins: new Set(["https://pilot.test"]),
    clientDist,
    runtimeIdleMs: 60_000,
    maxRuntimes: 8,
    runtimeCacheBytes: 32 * 1024 * 1024,
    wsMaxPayloadBytes: 128 * 1024,
    logLevel,
    logFile,
    configPath,
    production: withClient,
  };
  const app = await buildApp(config);
  apps.push(app);
  const added = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { path: projectPath },
  });
  if (added.statusCode !== 201) throw new Error(`Could not add test project: ${added.body}`);
  return { app, root, sessionDir, logFile, configPath, projectsPath, projectPath };
}

function socketMessageText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function flushLogger(app: FastifyInstance): Promise<void> {
  const log = app.log as typeof app.log & { flush(callback: (error?: Error) => void): void };
  return new Promise((resolve, reject) => {
    log.flush((error) => (error ? reject(error) : resolve()));
  });
}

async function setup(withClient = false): Promise<FastifyInstance> {
  return (await setupFixture(withClient)).app;
}

function workspaceStreamInbox() {
  const messages: WorkspaceSessionsStreamEnvelope[] = [];
  const waiters: Array<(message: WorkspaceSessionsStreamEnvelope) => void> = [];
  return {
    onInit: (socket: WebSocket) => {
      socket.on("message", (data) => {
        const envelope = parseWorkspaceSessionsStreamEnvelope(socketMessageText(data));
        const resolve = waiters.shift();
        if (resolve) resolve(envelope);
        else messages.push(envelope);
      });
    },
    next(): Promise<WorkspaceSessionsStreamEnvelope> {
      const message = messages.shift();
      return message
        ? Promise.resolve(message)
        : new Promise((resolve) => {
            waiters.push(resolve);
          });
    },
  };
}

describe("HTTP security and discovery", () => {
  it("discovers projects for an allowed browser origin without enabling CORS", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { origin: "https://pilot.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().projects[0].name).toBe("demo");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("adds and removes arbitrary project folders without changing config", async () => {
    const { app, root, configPath, projectsPath } = await setupFixture();
    const freshProject = join(root, "somewhere", "fresh-project");
    await mkdir(freshProject, { recursive: true });
    await writeFile(configPath, JSON.stringify({ port: 4321, logLevel: "debug" }));

    const added = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: freshProject },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().project).toMatchObject({ name: "fresh-project", path: freshProject });

    const projects = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projects.json().projects.map((project: { name: string }) => project.name)).toEqual([
      "demo",
      "fresh-project",
    ]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      port: 4321,
      logLevel: "debug",
    });
    expect(JSON.parse(await readFile(projectsPath, "utf8")).projects).toHaveLength(2);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${added.json().project.id}`,
    });
    expect(removed.statusCode).toBe(200);
    await expect(access(freshProject)).resolves.toBeUndefined();

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: "relative/path" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_project_path");
  });

  it("browses server directories without returning files", async () => {
    const { app, root } = await setupFixture();
    await writeFile(join(root, "not-a-folder.txt"), "hidden from the browser");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/filesystem/directories?${new URLSearchParams({ path: root })}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ path: root });
    expect(
      response.json().directories.map((directory: { name: string }) => directory.name),
    ).toContain("demo");
    expect(
      response.json().directories.map((directory: { name: string }) => directory.name),
    ).not.toContain("not-a-folder.txt");
  });

  it("allows Vite to use any loopback port in development", async () => {
    const app = await setup();
    for (const origin of ["http://127.0.0.1:5187", "http://localhost:6194"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { origin },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("does not allow arbitrary loopback ports in production", async () => {
    const app = await setup(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { origin: "http://127.0.0.1:5187" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an unexpected browser origin", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { origin: "https://evil.test" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("origin_rejected");
  });

  it("writes production logs to a file", async () => {
    const { app, logFile } = await setupFixture(true, "info");
    app.log.info("Production log destination test");
    await flushLogger(app);

    expect(await readFile(logFile, "utf8")).toContain("Production log destination test");
  });

  it("keeps development logs on stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { app } = await setupFixture(false, "info");
      app.log.info("Development stdout destination test");
      await flushLogger(app);

      expect(
        stdout.mock.calls.some(([value]) =>
          String(value).includes("Development stdout destination test"),
        ),
      ).toBe(true);
    } finally {
      stdout.mockRestore();
    }
  });

  it("serves the production SPA and nested assets from Fastify", async () => {
    const app = await setup(true);
    const index = await app.inject({ method: "GET", url: "/" });
    const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    const serviceWorker = await app.inject({ method: "GET", url: "/sw.js" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Pilot");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    expect(serviceWorker.headers["cache-control"]).toBe("no-cache");
    expect(serviceWorker.headers["service-worker-allowed"]).toBe("/");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("ready");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const compressed = await app.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { "accept-encoding": "br" },
    });
    expect(compressed.headers["content-encoding"]).toBe("br");
    expect(compressed.headers.vary?.toLowerCase()).toContain("accept-encoding");
  });

  it("renames, archives, restores, and deletes persistent sessions", async () => {
    const { app, sessionDir } = await setupFixture();
    const projectsResponse = await app.inject({ method: "GET", url: "/api/v1/projects" });
    const project = projectsResponse.json().projects[0];
    const id = "0195f4f0-7a00-7000-8000-000000000002";
    const timestamp = new Date().toISOString();
    const sessionFile = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: project.path })}\n`,
    );

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
      payload: { name: "Release audit" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().session.name).toBe("Release audit");
    expect(renamed.json().session.archived).toBe(false);
    expect(await readFile(sessionFile, "utf8")).toContain('"type":"session_info"');

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().session.archived).toBe(true);
    expect(await readFile(sessionFile, "utf8")).toContain('"customType":"pilot.session-state"');

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
      payload: { archived: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().session.archived).toBe(false);

    const read = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
      payload: { unread: false },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().session.unread).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, sessionId: id });
    await expect(access(sessionFile)).rejects.toThrow("ENOENT");
  });

  it("rejects blank session names", async () => {
    const { app, sessionDir } = await setupFixture();
    const projectsResponse = await app.inject({ method: "GET", url: "/api/v1/projects" });
    const project = projectsResponse.json().projects[0];
    const id = "0195f4f0-7a00-7000-8000-000000000003";
    const timestamp = new Date().toISOString();
    await writeFile(
      join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: project.path })}\n`,
    );

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/sessions/${id}`,
      payload: { name: "   " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_session_name");
  });

  it("streams every project's sessions through the workspace feed", async () => {
    const { app, sessionDir, projectPath } = await setupFixture();
    const projectsResponse = await app.inject({ method: "GET", url: "/api/v1/projects" });
    const project = projectsResponse.json().projects[0];
    const inbox = workspaceStreamInbox();
    const socket = await app.injectWS("/api/v1/sessions/ws", {}, { onInit: inbox.onInit });

    await expect(inbox.next()).resolves.toMatchObject({ kind: "workspace_sessions", sessions: [] });

    const id = "0195f4f0-7a00-7000-8000-000000000004";
    const timestamp = new Date().toISOString();
    const update = inbox.next();
    await writeFile(
      join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: projectPath })}\n`,
    );
    await expect(update).resolves.toMatchObject({
      kind: "workspace_sessions",
      sessions: [{ id, projectId: project.id }],
    });
    socket.terminate();
  });
});
