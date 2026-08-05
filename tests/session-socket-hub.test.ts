import { once } from "node:events";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { exceedsSocketBackpressure, SessionSocketHub } from "../src/server/session-socket-hub.js";
import {
  parseServerEnvelope,
  type ServerEnvelope,
  type SessionSnapshot,
} from "../src/shared/protocol.js";

const snapshot: SessionSnapshot = {
  identity: {
    id: "session-1234",
    projectId: "project",
    projectName: "Project",
    projectPath: "/tmp/project",
  },
  transcript: [],
  streamingMessage: null,
  tools: {},
  runtime: {
    phase: "idle",
    status: "idle",
    isBusy: false,
    queueDepth: 0,
    updatedAt: 1,
  },
  queue: { revision: 0, messages: [] },
  models: [],
  currentModel: null,
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  contextUsage: null,
  commands: [],
  permissionsNotice: "Not sandboxed",
  truncated: false,
};

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((task) => task()));
});

async function message(socket: WebSocket): Promise<ServerEnvelope> {
  const [data] = await once(socket, "message");
  return parseServerEnvelope(data.toString());
}

describe("SessionSocketHub", () => {
  it("bounds queued data while allowing one oversized canonical snapshot", () => {
    expect(exceedsSocketBackpressure(900, 200, 1_000)).toBe(true);
    expect(exceedsSocketBackpressure(0, 2_000, 1_000)).toBe(false);
    expect(exceedsSocketBackpressure(1_001, 1, 1_000)).toBe(true);
  });

  it("emits a fresh sequenced response for every command", async () => {
    const app = Fastify({ logger: false });
    const server = new WebSocketServer({ port: 0 });
    let executions = 0;
    const hub = new SessionSocketHub({
      sessionId: snapshot.identity.id,
      log: app.log,
      context: { sessionId: snapshot.identity.id },
      snapshot: () => snapshot,
      execute: async () => ({ execution: ++executions }),
      touch: () => {},
    });
    server.on("connection", (socket) => hub.attach(socket));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    closeTasks.push(async () => {
      if (client.readyState < WebSocket.CLOSING) client.close();
      hub.closeAll(1000, "test complete");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });

    const initialMessage = message(client);
    await once(client, "open");
    const initial = await initialMessage;
    expect(initial).toMatchObject({ kind: "event", event: { type: "snapshot" } });

    const command = JSON.stringify({
      kind: "command",
      requestId: "same-request",
      command: { type: "ping" },
    });
    const firstMessage = message(client);
    client.send(command);
    const first = await firstMessage;
    const secondMessage = message(client);
    client.send(command);
    const second = await secondMessage;

    expect(executions).toBe(2);
    expect(first).toMatchObject({ kind: "response", requestId: "same-request", ok: true });
    expect(second).toMatchObject({ kind: "response", requestId: "same-request", ok: true });
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("reuses an exact client snapshot without retransmitting it", async () => {
    const app = Fastify({ logger: false });
    const server = new WebSocketServer({ port: 0 });
    let cachedRevision: string | undefined;
    let snapshotCalls = 0;
    const hub = new SessionSocketHub({
      sessionId: snapshot.identity.id,
      log: app.log,
      context: { sessionId: snapshot.identity.id },
      snapshot: () => {
        snapshotCalls += 1;
        return snapshot;
      },
      execute: async () => ({}),
      touch: () => {},
    });
    server.on("connection", (socket) => hub.attach(socket, { revision: cachedRevision }));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected TCP address");

    const first = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const firstMessage = message(first);
    await once(first, "open");
    const initial = await firstMessage;
    expect(initial).toMatchObject({ kind: "event", event: { type: "snapshot" } });
    cachedRevision = initial.revision;
    first.close();
    await once(first, "close");

    const second = new WebSocket(`ws://127.0.0.1:${address.port}`);
    let third: WebSocket | undefined;
    closeTasks.push(async () => {
      if (second.readyState < WebSocket.CLOSING) second.close();
      if (third && third.readyState < WebSocket.CLOSING) third.close();
      hub.closeAll(1000, "test complete");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });
    const cachedMessage = message(second);
    await once(second, "open");
    expect(await cachedMessage).toMatchObject({
      kind: "event",
      event: { type: "session_ready" },
    });
    expect(snapshotCalls).toBe(1);

    second.close();
    await once(second, "close");
    hub.broadcast({ type: "notification", tone: "info", message: "changed" });
    third = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const staleMessage = message(third);
    await once(third, "open");
    expect(await staleMessage).toMatchObject({ kind: "event", event: { type: "snapshot" } });
    expect(snapshotCalls).toBe(2);
  });

  it("marks snapshot failures as retryable server failures", async () => {
    const app = Fastify({ logger: false });
    const server = new WebSocketServer({ port: 0 });
    const hub = new SessionSocketHub({
      sessionId: snapshot.identity.id,
      log: app.log,
      context: { sessionId: snapshot.identity.id },
      snapshot: () => {
        throw new Error("projection failed");
      },
      execute: async () => ({}),
      touch: () => {},
    });
    server.on("connection", (socket) => hub.attach(socket));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    closeTasks.push(async () => {
      if (client.readyState < WebSocket.CLOSING) client.close();
      hub.closeAll(1000, "test complete");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });

    const [code] = await once(client, "close");
    expect(code).toBe(1011);
  });
});
