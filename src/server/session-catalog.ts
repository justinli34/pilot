import { createReadStream, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  getAgentDir,
  SessionManager,
  SettingsManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { FastifyBaseLogger } from "fastify";

import { AppError } from "./errors.js";
import type { Project } from "./project-service.js";
import { safeLogMessage } from "./security.js";
import { appendSessionArchiveState, sessionArchiveValue } from "./session-metadata.js";

export interface CatalogSessionInfo extends SessionInfo {
  archived: boolean;
}

export interface SessionListResult {
  sessions: CatalogSessionInfo[];
}

const SESSION_LIST_CACHE_MS = 5_000;
const SESSION_CHANGE_DEBOUNCE_MS = 300;

interface CachedSessionList {
  expiresAt: number;
  result: SessionListResult;
  byPath: Map<string, CatalogSessionInfo>;
}

interface SessionWatch {
  watcher: FSWatcher;
  project: Project;
  directory: string;
  listeners: Set<() => void>;
  pendingFiles: Set<string>;
  rescan: boolean;
  timer?: NodeJS.Timeout;
  task?: Promise<void>;
}

interface ProjectCatalogState {
  version: number;
  cache?: CachedSessionList;
  listTask?: { version: number; task: Promise<SessionListResult> };
  watch?: SessionWatch;
}

type FileLoadResult =
  | { kind: "loaded"; info: CatalogSessionInfo }
  | { kind: "missing" }
  | { kind: "invalid" };

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(" ")
    .trim();
  if (text) return text;
  const imageCount = content.filter(
    (part) => typeof part === "object" && part !== null && "type" in part && part.type === "image",
  ).length;
  return imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "";
}

function validDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function loadSessionInfoFile(filePath: string): Promise<FileLoadResult> {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing" };
    throw error;
  }

  let header: Record<string, unknown> | undefined;
  let name: string | undefined;
  let archived = false;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivity = 0;
  const allMessages: string[] = [];
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        entry = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      if (!header) {
        if (entry.type !== "session") return { kind: "invalid" };
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
        continue;
      }
      const archiveValue = sessionArchiveValue(entry);
      if (archiveValue !== undefined) {
        archived = archiveValue;
        continue;
      }
      if (entry.type !== "message") continue;
      messageCount += 1;
      const message = entry.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
      const record = message as Record<string, unknown>;
      if (record.role !== "user" && record.role !== "assistant") continue;
      const at =
        typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
          ? record.timestamp
          : (validDate(entry.timestamp)?.getTime() ?? 0);
      lastActivity = Math.max(lastActivity, at);
      const text = messageText(record.content);
      if (!text) continue;
      allMessages.push(text);
      if (!firstMessage && record.role === "user") firstMessage = text;
    }
  } catch (error) {
    if (isMissingFile(error)) return { kind: "missing" };
    throw error;
  }

  if (!header || typeof header.id !== "string") return { kind: "invalid" };
  const created = validDate(header.timestamp) ?? fileStats.birthtime;
  const headerTimestamp = validDate(header.timestamp);
  return {
    kind: "loaded",
    info: {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      ...(name ? { name } : {}),
      ...(typeof header.parentSession === "string"
        ? { parentSessionPath: header.parentSession }
        : {}),
      created,
      modified: lastActivity > 0 ? new Date(lastActivity) : (headerTimestamp ?? fileStats.mtime),
      messageCount,
      archived,
      firstMessage: firstMessage || "(no messages)",
      allMessagesText: allMessages.join(" "),
    },
  };
}

function sameVisibleCatalog(
  left: SessionListResult | undefined,
  right: SessionListResult,
): boolean {
  if (!left || left.sessions.length !== right.sessions.length) return false;
  return left.sessions.every((session, index) => {
    const next = right.sessions[index];
    return (
      next !== undefined &&
      session.id === next.id &&
      session.path === next.path &&
      session.cwd === next.cwd &&
      session.name === next.name &&
      session.parentSessionPath === next.parentSessionPath &&
      session.created.getTime() === next.created.getTime() &&
      session.modified.getTime() === next.modified.getTime() &&
      session.firstMessage === next.firstMessage &&
      session.archived === next.archived
    );
  });
}

export class SessionCatalog {
  readonly agentDir = getAgentDir();
  private readonly projectStates = new Map<string, ProjectCatalogState>();
  private closed = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  private projectState(projectId: string): ProjectCatalogState {
    let state = this.projectStates.get(projectId);
    if (!state) {
      state = { version: 0 };
      this.projectStates.set(projectId, state);
    }
    return state;
  }

  private sessionDir(project: Project): string | undefined {
    const settings = SettingsManager.create(project.path, this.agentDir);
    for (const issue of settings.drainErrors()) {
      this.log.warn(
        { projectId: project.id, scope: issue.scope, error: safeLogMessage(issue.error) },
        "Pi settings could not be read while locating sessions",
      );
    }
    const configured = process.env.PI_CODING_AGENT_SESSION_DIR ?? settings.getSessionDir();
    if (!configured) return undefined;
    const expanded = expandHome(configured);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(project.path, expanded);
  }

  private result(byPath: ReadonlyMap<string, CatalogSessionInfo>): SessionListResult {
    const matching = [...byPath.values()].sort(
      (left, right) =>
        right.modified.getTime() - left.modified.getTime() || left.id.localeCompare(right.id),
    );
    return { sessions: matching };
  }

  private async scan(project: Project): Promise<CachedSessionList> {
    const listed = await SessionManager.list(project.path, this.sessionDir(project));
    const loaded = await Promise.all(listed.map((session) => loadSessionInfoFile(session.path)));
    const matching = loaded.flatMap((result) =>
      result.kind === "loaded" && (!result.info.cwd || resolve(result.info.cwd) === project.path)
        ? [result.info]
        : [],
    );
    const byPath = new Map(matching.map((session) => [resolve(session.path), session]));
    return {
      expiresAt: Date.now() + SESSION_LIST_CACHE_MS,
      result: this.result(byPath),
      byPath,
    };
  }

  list(project: Project): Promise<SessionListResult> {
    const state = this.projectState(project.id);
    const version = state.version;
    if (state.cache && (state.watch || state.cache.expiresAt > Date.now())) {
      return Promise.resolve(state.cache.result);
    }
    if (state.listTask?.version === version) return state.listTask.task;

    const task = this.scan(project).then((next) => {
      if (state.version === version) state.cache = next;
      return next.result;
    });
    state.listTask = { version, task };
    const clearTask = () => {
      if (state.listTask?.task === task) state.listTask = undefined;
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  private invalidate(projectId: string): void {
    const state = this.projectState(projectId);
    state.version += 1;
    state.cache = undefined;
  }

  private notify(state: SessionWatch): void {
    for (const listener of state.listeners) {
      try {
        listener();
      } catch (error) {
        this.log.debug(
          { projectId: state.project.id, error: safeLogMessage(error) },
          "Session catalog listener failed",
        );
      }
    }
  }

  private async updateFiles(project: Project, filePaths: readonly string[]): Promise<boolean> {
    const state = this.projectState(project.id);
    const cached = state.cache;
    if (!cached) {
      this.invalidate(project.id);
      await this.list(project);
      return true;
    }

    state.version += 1;
    const byPath = new Map(cached.byPath);
    const loaded = await Promise.all(
      filePaths.map(async (filePath) => [filePath, await loadSessionInfoFile(filePath)] as const),
    );
    for (const [filePath, result] of loaded) {
      if (result.kind === "missing") {
        byPath.delete(filePath);
      } else if (result.kind === "loaded") {
        if (!result.info.cwd || resolve(result.info.cwd) === project.path) {
          byPath.set(filePath, result.info);
        } else {
          byPath.delete(filePath);
        }
      }
    }
    const next: CachedSessionList = {
      expiresAt: Date.now() + SESSION_LIST_CACHE_MS,
      result: this.result(byPath),
      byPath,
    };
    state.cache = next;
    return !sameVisibleCatalog(cached.result, next.result);
  }

  private async flushChanges(watch: SessionWatch): Promise<void> {
    const state = this.projectState(watch.project.id);
    if (state.watch !== watch) return;
    const files = [...watch.pendingFiles];
    const rescan = watch.rescan;
    watch.pendingFiles.clear();
    watch.rescan = false;

    let changed = false;
    if (rescan) {
      const previous = state.cache?.result;
      this.invalidate(watch.project.id);
      const next = await this.list(watch.project);
      changed = !sameVisibleCatalog(previous, next);
    } else if (files.length > 0) {
      changed = await this.updateFiles(watch.project, files);
    }
    if (changed && state.watch === watch) this.notify(watch);
  }

  private queueChange(state: SessionWatch, filename: string | null): void {
    if (filename === null) {
      state.rescan = true;
    } else {
      if (basename(filename) !== filename || !filename.endsWith(".jsonl")) return;
      state.pendingFiles.add(resolve(state.directory, filename));
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const previous = state.task ?? Promise.resolve();
      state.task = previous
        .then(() => this.flushChanges(state))
        .catch((error) => {
          this.log.error(
            { projectId: state.project.id, error: safeLogMessage(error) },
            "Incremental session catalog refresh failed",
          );
          state.rescan = true;
        });
    }, SESSION_CHANGE_DEBOUNCE_MS);
    state.timer.unref();
  }

  async subscribe(project: Project, listener: () => void): Promise<() => void> {
    if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
    const projectState = this.projectState(project.id);
    let sessionWatch = projectState.watch;
    if (!sessionWatch) {
      const directory =
        this.sessionDir(project) ?? SessionManager.create(project.path).getSessionDir();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (this.closed) throw new AppError(503, "server_stopping", "Server is shutting down");
      sessionWatch = projectState.watch;
      if (!sessionWatch) {
        let created!: SessionWatch;
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          this.queueChange(created, filename?.toString() ?? null);
        });
        created = {
          watcher,
          project,
          directory,
          listeners: new Set(),
          pendingFiles: new Set(),
          rescan: false,
        };
        watcher.on("error", (error) => {
          this.log.warn(
            { projectId: project.id, error: safeLogMessage(error) },
            "Session directory watcher failed",
          );
          this.queueChange(created, null);
        });
        projectState.watch = created;
        sessionWatch = created;
        // Changes may have landed while no browser was subscribed. Seed a fresh index after the
        // watcher is active; subsequent events update only their individual JSONL file.
        this.invalidate(project.id);
      }
    }

    sessionWatch.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.projectStates.get(project.id)?.watch;
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      if (current.timer) clearTimeout(current.timer);
      current.watcher.close();
      projectState.watch = undefined;
    };
  }

  close(): void {
    this.closed = true;
    for (const state of this.projectStates.values()) {
      const sessionWatch = state.watch;
      if (!sessionWatch) continue;
      if (sessionWatch.timer) clearTimeout(sessionWatch.timer);
      sessionWatch.watcher.close();
      state.watch = undefined;
    }
  }

  async find(project: Project, sessionId: string): Promise<CatalogSessionInfo> {
    if (!/^[A-Za-z0-9-]{8,128}$/.test(sessionId)) {
      throw new AppError(400, "invalid_session", "Invalid session identifier");
    }
    const cached = this.projectStates
      .get(project.id)
      ?.cache?.result.sessions.find((candidate) => candidate.id === sessionId);
    const session =
      cached ?? (await this.list(project)).sessions.find((candidate) => candidate.id === sessionId);
    if (!session)
      throw new AppError(404, "session_not_found", "Session was not found for this project");
    return session;
  }

  private async mutableSessionPath(project: Project, info: SessionInfo): Promise<string> {
    const expectedDirectory = resolve(
      this.sessionDir(project) ?? SessionManager.create(project.path).getSessionDir(),
    );
    const filePath = resolve(info.path);
    if (
      dirname(filePath) !== expectedDirectory ||
      extname(filePath) !== ".jsonl" ||
      basename(filePath) !== basename(info.path)
    ) {
      throw new AppError(
        409,
        "session_path_mismatch",
        "Session file is outside the selected project's session directory",
      );
    }
    let fileStats;
    try {
      fileStats = await lstat(filePath);
    } catch (error) {
      if (isMissingFile(error)) {
        throw new AppError(404, "session_not_found", "Session file no longer exists");
      }
      throw error;
    }
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new AppError(409, "invalid_session_file", "Session path is not a regular file");
    }
    return filePath;
  }

  private async refreshFile(project: Project, filePath: string): Promise<CatalogSessionInfo> {
    const changed = await this.updateFiles(project, [filePath]);
    const state = this.projectState(project.id);
    if (changed && state.watch) this.notify(state.watch);
    const info = state.cache?.byPath.get(filePath);
    if (!info) throw new AppError(404, "session_not_found", "Session was not found");
    return info;
  }

  async refreshSession(project: Project, info: SessionInfo): Promise<CatalogSessionInfo> {
    const filePath = await this.mutableSessionPath(project, info);
    return this.refreshFile(project, filePath);
  }

  async renameSession(
    project: Project,
    info: SessionInfo,
    name: string,
  ): Promise<CatalogSessionInfo> {
    const filePath = await this.mutableSessionPath(project, info);
    this.open(project, { ...info, path: filePath }).appendSessionInfo(name);
    return this.refreshFile(project, filePath);
  }

  async setSessionArchived(
    project: Project,
    info: SessionInfo,
    archived: boolean,
  ): Promise<CatalogSessionInfo> {
    const filePath = await this.mutableSessionPath(project, info);
    appendSessionArchiveState(this.open(project, { ...info, path: filePath }), archived);
    return this.refreshFile(project, filePath);
  }

  async deleteSession(project: Project, info: SessionInfo): Promise<void> {
    const filePath = await this.mutableSessionPath(project, info);
    await unlink(filePath);
    const changed = await this.updateFiles(project, [filePath]);
    const sessionWatch = this.projectState(project.id).watch;
    if (changed && sessionWatch) this.notify(sessionWatch);
  }

  async create(project: Project): Promise<SessionManager> {
    const sessionDir = this.sessionDir(project);
    const pending = SessionManager.create(project.path, sessionDir);
    const sessionFile = pending.getSessionFile();
    const header = pending.getHeader();
    if (!sessionFile || !header) {
      throw new AppError(
        500,
        "session_create_failed",
        "Pi did not provide a persistent session file",
      );
    }

    await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    const changed = await this.updateFiles(project, [resolve(sessionFile)]);
    const sessionWatch = this.projectState(project.id).watch;
    if (changed && sessionWatch) this.notify(sessionWatch);
    return SessionManager.open(sessionFile, sessionDir, project.path);
  }

  open(project: Project, info: SessionInfo): SessionManager {
    if (info.cwd && resolve(info.cwd) !== project.path) {
      throw new AppError(
        409,
        "session_project_mismatch",
        "Session working directory does not match the selected project",
      );
    }
    return SessionManager.open(info.path, this.sessionDir(project), project.path);
  }
}
