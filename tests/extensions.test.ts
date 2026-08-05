import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { RuntimeHost } from "../src/server/runtime-host.js";
import { parseServerEnvelope, type ServerEnvelope } from "../src/shared/protocol.js";

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
  }

  envelopes(): ServerEnvelope[] {
    return this.sent.map(parseServerEnvelope);
  }
}

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((task) => task()));
});

describe("Pi extensions", () => {
  it("projects every invokable command and forwards extension notifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilot-extensions-"));
    const projectPath = join(root, "project");
    const agentDir = join(root, "agent");
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(join(agentDir, "extensions"), { recursive: true }),
      mkdir(join(agentDir, "prompts"), { recursive: true }),
      mkdir(join(agentDir, "skills", "sample-skill"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(agentDir, "extensions", "notify.ts"),
        `export default function (pi) {
          pi.registerCommand("notify-test", {
            description: "Send a test notification",
            handler: async (_args, ctx) => ctx.ui.notify("Extension notification", "warning"),
          });
        }`,
      ),
      writeFile(
        join(agentDir, "prompts", "review.md"),
        "---\ndescription: Review the project\n---\nReview the project.",
      ),
      writeFile(
        join(agentDir, "skills", "sample-skill", "SKILL.md"),
        "---\nname: sample-skill\ndescription: Use the sample workflow\n---\nFollow the workflow.",
      ),
    ]);

    const app = Fastify({ logger: false });
    const host = await RuntimeHost.create({
      project: { id: "project", name: "project", path: projectPath },
      manager: SessionManager.inMemory(projectPath),
      agentDir,
      log: app.log,
    });
    cleanupTasks.push(async () => {
      await host.dispose("test");
      await app.close();
      await rm(root, { recursive: true, force: true });
    });

    const socket = new TestSocket();
    host.attach(socket as unknown as WebSocket);
    const initial = socket.envelopes()[0];
    expect(initial).toMatchObject({ kind: "event", event: { type: "snapshot" } });
    if (initial?.kind !== "event" || initial.event.type !== "snapshot") {
      throw new Error("Expected an initial snapshot");
    }
    expect(initial.event.snapshot.commands).toEqual(
      expect.arrayContaining([
        {
          name: "notify-test",
          description: "Send a test notification",
          source: "extension",
        },
        { name: "review", description: "Review the project", source: "prompt" },
        {
          name: "skill:sample-skill",
          description: "Use the sample workflow",
          source: "skill",
        },
      ]),
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          kind: "command",
          requestId: "notify-command",
          command: { type: "prompt", text: "/notify-test" },
        }),
      ),
      false,
    );
    await vi.waitFor(() => {
      expect(socket.envelopes()).toContainEqual(
        expect.objectContaining({
          kind: "event",
          event: {
            type: "notification",
            tone: "warning",
            message: "Extension notification",
          },
        }),
      );
    });
  });
});
