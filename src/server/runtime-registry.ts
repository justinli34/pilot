import type { SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";

import type { RuntimePhase, SessionStatus } from "../shared/protocol.js";
import { AppError } from "./errors.js";
import type { Project } from "./project-service.js";
import { RuntimeHost, type RuntimeHostOptions } from "./runtime-host.js";
import { safeLogMessage } from "./security.js";
import type { CatalogSessionInfo } from "./session-catalog.js";
import type { SocketAttachOptions } from "./session-socket-hub.js";

interface RuntimeCatalog {
  readonly agentDir: string;
  open(project: Project, info: SessionInfo): SessionManager;
  create(project: Project): Promise<SessionManager>;
  refreshSession(project: Project, info: SessionInfo): Promise<CatalogSessionInfo>;
  renameSession(project: Project, info: SessionInfo, name: string): Promise<CatalogSessionInfo>;
  setSessionArchived(
    project: Project,
    info: SessionInfo,
    archived: boolean,
  ): Promise<CatalogSessionInfo>;
  deleteSession(project: Project, info: SessionInfo): Promise<void>;
}

export interface RuntimeHandle {
  readonly sessionId: string;
  readonly project: Project;
  readonly lastActivity: number;
  status(): { status: SessionStatus; phase: RuntimePhase };
  estimatedSize(): number;
  canDispose(now: number, idleMs: number): boolean;
  readonly isIdle: boolean;
  renameSession(name: string): void;
  setSessionArchived(archived: boolean): void;
  attach(socket: WebSocket, options?: SocketAttachOptions): void;
  dispose(reason?: string): Promise<void>;
}

export type RuntimeHostFactory = (options: RuntimeHostOptions) => Promise<RuntimeHandle>;

export class RuntimeRegistry {
  private readonly hosts = new Map<string, RuntimeHandle>();
  private readonly opening = new Map<string, Promise<RuntimeHandle>>();
  private readonly loading = new Map<string, Promise<RuntimeHandle>>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly runtimeStatuses = new Map<
    string,
    { projectId: string; status: SessionStatus }
  >();
  private readonly unreadSessions = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly sweepTimer: NodeJS.Timeout;
  private capacityLock = Promise.resolve();
  private capacityReservations = 0;
  private sweeping = false;
  private closed = false;

  constructor(
    private readonly catalog: RuntimeCatalog,
    private readonly idleMs: number,
    private readonly maxHosts: number,
    private readonly maxCachedBytes: number,
    private readonly log: FastifyBaseLogger,
    private readonly createHost: RuntimeHostFactory = (options) => RuntimeHost.create(options),
  ) {
    this.sweepTimer = setInterval(
      () => void this.sweep(),
      Math.min(60_000, Math.max(10_000, idleMs / 2)),
    );
    this.sweepTimer.unref();
  }

  status(sessionId: string): { status: SessionStatus; phase: RuntimePhase } {
    return this.hosts.get(sessionId)?.status() ?? { status: "idle", phase: "idle" };
  }

  isUnread(sessionId: string): boolean {
    return this.unreadSessions.has(sessionId);
  }

  markSessionRead(projectId: string, sessionId: string): void {
    if (this.unreadSessions.get(sessionId) !== projectId) return;
    this.unreadSessions.delete(sessionId);
    this.notify(projectId);
  }

  subscribe(projectId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(projectId);
    };
  }

  private recordRuntimeStatus(projectId: string, sessionId: string, status: SessionStatus): void {
    const previous = this.runtimeStatuses.get(sessionId)?.status;
    this.runtimeStatuses.set(sessionId, { projectId, status });
    if (previous === "running" && status === "idle") {
      this.unreadSessions.set(sessionId, projectId);
    }
  }

  private runtimeChanged(projectId: string, sessionId: string): void {
    const host = this.hosts.get(sessionId);
    if (host) this.recordRuntimeStatus(projectId, sessionId, host.status().status);
    this.notify(projectId);
  }

  private notify(projectId: string): void {
    for (const listener of this.listeners.get(projectId) ?? []) {
      try {
        listener();
      } catch (error) {
        this.log.debug(
          { projectId, error: safeLogMessage(error) },
          "Runtime status listener failed",
        );
      }
    }
  }

  private async withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.capacityLock;
    let release = () => {};
    this.capacityLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async disposeHost(id: string, host: RuntimeHandle, reason: string): Promise<void> {
    if (this.hosts.get(id) !== host) return;
    this.hosts.delete(id);
    this.notify(host.project.id);
    const disposal = host.dispose(reason);
    this.disposing.set(id, disposal);
    try {
      await disposal;
    } finally {
      if (this.disposing.get(id) === disposal) this.disposing.delete(id);
    }
  }

  private disposableHosts(protectedId?: string): Array<[string, RuntimeHandle]> {
    const now = Date.now();
    return [...this.hosts]
      .filter(([id, host]) => id !== protectedId && host.canDispose(now, 0))
      .sort((left, right) => left[1].lastActivity - right[1].lastActivity);
  }

  private async reserveCapacity(): Promise<void> {
    await this.withCapacityLock(async () => {
      if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
      while (this.hosts.size + this.loading.size + this.capacityReservations >= this.maxHosts) {
        const candidate = this.disposableHosts()[0];
        if (!candidate) {
          throw new AppError(
            503,
            "runtime_capacity",
            "All cached session runtimes are active; close or stop another session and retry",
          );
        }
        await this.disposeHost(candidate[0], candidate[1], "capacity-limit");
      }
      this.capacityReservations += 1;
    });
  }

  private releaseCapacity(): void {
    this.capacityReservations = Math.max(0, this.capacityReservations - 1);
  }

  private async enforceByteBudget(protectedId?: string): Promise<void> {
    await this.withCapacityLock(async () => {
      const size = () =>
        [...this.hosts.values()].reduce((total, host) => {
          try {
            return total + host.estimatedSize();
          } catch {
            return total + this.maxCachedBytes;
          }
        }, 0);
      let total = size();
      while (total > this.maxCachedBytes) {
        const candidate = this.disposableHosts(protectedId)[0];
        if (!candidate) break;
        await this.disposeHost(candidate[0], candidate[1], "cache-byte-limit");
        total = size();
      }
    });
  }

  private verifyProject(host: RuntimeHandle, project: Project): RuntimeHandle {
    if (host.project.id !== project.id) {
      throw new AppError(
        409,
        "session_project_mismatch",
        "Session runtime belongs to a different project",
      );
    }
    return host;
  }

  private async openUncached(project: Project, info: SessionInfo): Promise<RuntimeHandle> {
    await this.reserveCapacity();
    let promise: Promise<RuntimeHandle>;
    try {
      promise = this.createHost({
        project,
        manager: this.catalog.open(project, info),
        agentDir: this.catalog.agentDir,
        log: this.log,
        onRuntimeChange: () => this.runtimeChanged(project.id, info.id),
      });
      this.loading.set(info.id, promise);
    } catch (error) {
      this.releaseCapacity();
      throw error;
    }
    this.releaseCapacity();
    try {
      const host = await promise;
      if (host.sessionId !== info.id) {
        await host.dispose("session-id-mismatch");
        throw new AppError(
          409,
          "session_id_mismatch",
          "Pi opened a session with an unexpected identifier",
        );
      }
      if (this.deleting.has(info.id)) {
        await host.dispose("session-deleted-during-open");
        throw new AppError(409, "session_deleting", "Session is being deleted");
      }
      this.hosts.set(info.id, host);
      this.recordRuntimeStatus(project.id, info.id, host.status().status);
      this.notify(project.id);
      await this.enforceByteBudget(info.id);
      return host;
    } finally {
      this.loading.delete(info.id);
    }
  }

  async open(project: Project, info: SessionInfo): Promise<RuntimeHandle> {
    if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
    if (this.deleting.has(info.id)) {
      throw new AppError(409, "session_deleting", "Session is being deleted");
    }
    const disposal = this.disposing.get(info.id);
    if (disposal) await disposal;

    const existing = this.hosts.get(info.id);
    if (existing) return this.verifyProject(existing, project);
    const pending = this.opening.get(info.id) ?? this.loading.get(info.id);
    if (pending) return this.verifyProject(await pending, project);

    const task = this.openUncached(project, info);
    this.opening.set(info.id, task);
    try {
      return this.verifyProject(await task, project);
    } finally {
      if (this.opening.get(info.id) === task) this.opening.delete(info.id);
    }
  }

  private assertMutable(sessionId: string, alreadyDeleting = false): void {
    if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
    if (this.deleting.has(sessionId)) {
      throw new AppError(
        409,
        "session_deleting",
        alreadyDeleting ? "Session is already being deleted" : "Session is being deleted",
      );
    }
  }

  private async existingHost(
    project: Project,
    sessionId: string,
  ): Promise<RuntimeHandle | undefined> {
    const disposal = this.disposing.get(sessionId);
    if (disposal) await disposal;
    const pending = this.opening.get(sessionId) ?? this.loading.get(sessionId);
    const host = this.hosts.get(sessionId) ?? (pending ? await pending : undefined);
    return host ? this.verifyProject(host, project) : undefined;
  }

  private ensureIdle(host: RuntimeHandle, message: string): void {
    if (!host.isIdle) throw new AppError(409, "session_busy", message);
  }

  private async disposeResolvedHost(
    sessionId: string,
    host: RuntimeHandle,
    reason: string,
  ): Promise<void> {
    if (this.hosts.get(sessionId) === host) await this.disposeHost(sessionId, host, reason);
    else await host.dispose(reason);
  }

  async renameSession(
    project: Project,
    info: SessionInfo,
    name: string,
  ): Promise<CatalogSessionInfo> {
    this.assertMutable(info.id);
    const host = await this.existingHost(project, info.id);
    if (!host) return this.catalog.renameSession(project, info, name);
    host.renameSession(name);
    return this.catalog.refreshSession(project, info);
  }

  async setSessionArchived(
    project: Project,
    info: SessionInfo,
    archived: boolean,
  ): Promise<CatalogSessionInfo> {
    this.assertMutable(info.id);
    const host = await this.existingHost(project, info.id);
    if (!host) return this.catalog.setSessionArchived(project, info, archived);
    this.ensureIdle(
      host,
      `Stop the running session before ${archived ? "archiving" : "unarchiving"} it`,
    );
    host.setSessionArchived(archived);
    return this.catalog.refreshSession(project, info);
  }

  async deleteSession(project: Project, info: SessionInfo): Promise<void> {
    this.assertMutable(info.id, true);
    this.deleting.add(info.id);
    try {
      const host = await this.existingHost(project, info.id);
      if (host) {
        this.ensureIdle(host, "Stop the running session before deleting it");
        await this.disposeResolvedHost(info.id, host, "session-deleted");
      }
      await this.catalog.deleteSession(project, info);
      this.runtimeStatuses.delete(info.id);
      this.unreadSessions.delete(info.id);
    } finally {
      this.deleting.delete(info.id);
    }
  }

  async releaseProject(projectId: string): Promise<void> {
    const hosts = [...this.hosts].filter(([, host]) => host.project.id === projectId);
    if (hosts.some(([, host]) => host.status().status === "running")) {
      throw new AppError(
        409,
        "project_busy",
        "Stop the project's running sessions before removing it",
      );
    }
    await Promise.all(hosts.map(([id, host]) => this.disposeHost(id, host, "project-removed")));
    for (const [sessionId, runtime] of this.runtimeStatuses) {
      if (runtime.projectId !== projectId) continue;
      this.runtimeStatuses.delete(sessionId);
      this.unreadSessions.delete(sessionId);
    }
  }

  async create(project: Project): Promise<RuntimeHandle> {
    if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
    await this.reserveCapacity();
    let manager: SessionManager;
    try {
      manager = await this.catalog.create(project);
    } catch (error) {
      this.releaseCapacity();
      throw error;
    }
    const id = manager.getSessionId();
    let promise: Promise<RuntimeHandle>;
    try {
      promise = this.createHost({
        project,
        manager,
        agentDir: this.catalog.agentDir,
        log: this.log,
        onRuntimeChange: () => this.runtimeChanged(project.id, id),
      });
      this.loading.set(id, promise);
    } catch (error) {
      this.releaseCapacity();
      throw error;
    }
    this.releaseCapacity();
    try {
      const host = await promise;
      if (this.deleting.has(host.sessionId)) {
        await host.dispose("session-deleted-during-create");
        throw new AppError(409, "session_deleting", "Session is being deleted");
      }
      this.hosts.set(host.sessionId, host);
      this.recordRuntimeStatus(project.id, host.sessionId, host.status().status);
      this.notify(project.id);
      await this.enforceByteBudget(host.sessionId);
      return host;
    } finally {
      this.loading.delete(id);
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      const disposable = [...this.hosts].filter(([, host]) => host.canDispose(now, this.idleMs));
      for (const [id, host] of disposable) {
        this.hosts.delete(id);
        this.notify(host.project.id);
      }
      await Promise.all(
        disposable.map(async ([id, host]) => {
          const disposal = host.dispose("idle-timeout");
          this.disposing.set(id, disposal);
          try {
            await disposal;
          } finally {
            this.disposing.delete(id);
          }
        }),
      );
      await this.enforceByteBudget();
    } finally {
      this.sweeping = false;
    }
  }

  async disposeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const hosts = [...this.hosts.values()];
    const pending = new Map(this.loading);
    for (const [id, task] of this.opening) pending.set(id, task);
    this.hosts.clear();
    this.runtimeStatuses.clear();
    this.unreadSessions.clear();
    this.listeners.clear();
    await Promise.allSettled([
      ...hosts.map((host) => host.dispose("server-shutdown")),
      ...this.disposing.values(),
      ...[...pending.values()].map(async (hostPromise) =>
        (await hostPromise).dispose("server-shutdown"),
      ),
    ]);
  }
}
