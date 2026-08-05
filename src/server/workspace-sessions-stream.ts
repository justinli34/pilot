import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";

import type { SessionSummary } from "../shared/protocol.js";
import type { ProjectService } from "./project-service.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { safeLogMessage } from "./security.js";
import type { SessionCatalog } from "./session-catalog.js";
import { exceedsSocketBackpressure } from "./session-socket-hub.js";

interface WorkspaceSessionsStreamOptions {
  projects: ProjectService;
  catalog: SessionCatalog;
  registry: RuntimeRegistry;
  log: FastifyBaseLogger;
  snapshot: () => Promise<SessionSummary[]>;
}

export class WorkspaceSessionsStreamHub {
  private readonly clients = new Set<WebSocket>();
  private readonly catalogSubscriptions = new Map<string, () => void>();
  private readonly runtimeSubscriptions = new Map<string, () => void>();
  private unsubscribeProjects?: () => void;
  private syncTail: Promise<void> = Promise.resolve();
  private refreshTail: Promise<void> = Promise.resolve();
  private refreshTimer?: NodeJS.Timeout;
  private started = false;
  private closed = false;
  private lastPayload?: string;

  constructor(private readonly options: WorkspaceSessionsStreamOptions) {}

  async attach(socket: WebSocket): Promise<void> {
    if (this.closed) {
      socket.close(1012, "Server is stopping");
      return;
    }
    this.clients.add(socket);
    socket.once("close", () => {
      this.clients.delete(socket);
      if (this.clients.size === 0) this.stop();
    });
    socket.once("error", (error) => {
      this.options.log.debug(
        { error: safeLogMessage(error) },
        "Workspace sessions WebSocket client error",
      );
    });

    const alreadyStarted = this.started;
    if (!this.started) await this.start();
    if (alreadyStarted && this.lastPayload) this.safeSend(socket, this.lastPayload);
    else if (!this.lastPayload) await this.queueRefresh();
  }

  private async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribeProjects = this.options.projects.subscribe(() => {
      void this.queueSync();
    });
    await this.queueSync();
  }

  private queueSync(): Promise<void> {
    const task = this.syncTail.then(() => this.syncProjects());
    this.syncTail = task.catch((error) => {
      this.options.log.error(
        { error: safeLogMessage(error) },
        "Could not update workspace session subscriptions",
      );
    });
    return task;
  }

  private async syncProjects(): Promise<void> {
    if (!this.started || this.closed) return;
    const projects = this.options.projects.list();
    const ids = new Set(projects.map((project) => project.id));
    for (const [id, unsubscribe] of this.catalogSubscriptions) {
      if (ids.has(id)) continue;
      unsubscribe();
      this.catalogSubscriptions.delete(id);
    }
    for (const [id, unsubscribe] of this.runtimeSubscriptions) {
      if (ids.has(id)) continue;
      unsubscribe();
      this.runtimeSubscriptions.delete(id);
    }
    for (const project of projects) {
      if (!this.runtimeSubscriptions.has(project.id)) {
        this.runtimeSubscriptions.set(
          project.id,
          this.options.registry.subscribe(project.id, () => this.scheduleRefresh()),
        );
      }
      if (!this.catalogSubscriptions.has(project.id)) {
        const unsubscribe = await this.options.catalog.subscribe(project, () =>
          this.scheduleRefresh(),
        );
        if (
          !this.started ||
          this.closed ||
          !this.options.projects.list().some((item) => item.id === project.id)
        ) {
          unsubscribe();
        } else {
          this.catalogSubscriptions.set(project.id, unsubscribe);
        }
      }
    }
    await this.queueRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || !this.started || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.queueRefresh();
    }, 30);
    this.refreshTimer.unref();
  }

  private queueRefresh(): Promise<void> {
    const task = this.refreshTail.then(() => this.refresh());
    this.refreshTail = task.catch((error) => {
      this.options.log.error(
        { error: safeLogMessage(error) },
        "Could not refresh workspace sessions stream",
      );
    });
    return task;
  }

  private async refresh(): Promise<void> {
    if (!this.started || this.closed || this.clients.size === 0) return;
    const sessions = await this.options.snapshot();
    const payload = JSON.stringify({
      kind: "workspace_sessions",
      sessions,
    });
    this.lastPayload = payload;
    for (const client of this.clients) this.safeSend(client, payload);
  }

  private safeSend(socket: WebSocket, payload: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (exceedsSocketBackpressure(socket.bufferedAmount, Buffer.byteLength(payload))) {
      socket.close(1009, "Workspace session updates are too large");
      return;
    }
    try {
      socket.send(payload);
    } catch (error) {
      this.options.log.debug(
        { error: safeLogMessage(error) },
        "Could not send workspace sessions update",
      );
      socket.close(1011, "Could not send workspace session updates");
    }
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    this.lastPayload = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.unsubscribeProjects?.();
    this.unsubscribeProjects = undefined;
    for (const unsubscribe of this.catalogSubscriptions.values()) unsubscribe();
    for (const unsubscribe of this.runtimeSubscriptions.values()) unsubscribe();
    this.catalogSubscriptions.clear();
    this.runtimeSubscriptions.clear();
  }

  closeAll(): void {
    this.closed = true;
    for (const client of this.clients) client.close(1001, "Server is stopping");
    this.clients.clear();
    this.stop();
  }
}
