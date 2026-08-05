import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { DirectoryListing, ProjectSummary } from "../shared/protocol.js";
import { AppError } from "./errors.js";

interface ProjectRegistryFile {
  version: 1;
  projects: Array<{ path: string }>;
}

export type Project = ProjectSummary;

function projectId(path: string): string {
  return createHash("sha256").update(path).digest("base64url").slice(0, 24);
}

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function canonicalDirectory(path: string, action: "add" | "browse"): Promise<string> {
  if (!isAbsolute(path)) {
    throw new AppError(400, "invalid_project_path", "Enter an absolute server path");
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new AppError(403, "directory_forbidden", "Pilot cannot access this directory");
    }
    throw new AppError(
      action === "add" ? 400 : 404,
      action === "add" ? "invalid_project_path" : "directory_not_found",
      "Directory does not exist",
    );
  }

  let info;
  try {
    info = await stat(canonical);
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new AppError(403, "directory_forbidden", "Pilot cannot access this directory");
    }
    throw new AppError(404, "directory_not_found", "Directory does not exist");
  }
  if (!info.isDirectory()) {
    throw new AppError(
      400,
      action === "add" ? "invalid_project_path" : "invalid_directory",
      "Path is not a directory",
    );
  }
  return canonical;
}

function parseRegistry(value: unknown, path: string): ProjectRegistryFile {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "version" && key !== "projects") ||
    !("version" in value) ||
    value.version !== 1 ||
    !("projects" in value) ||
    !Array.isArray(value.projects) ||
    value.projects.some(
      (project) =>
        typeof project !== "object" ||
        project === null ||
        Array.isArray(project) ||
        Object.keys(project).some((key) => key !== "path") ||
        !("path" in project) ||
        typeof project.path !== "string" ||
        !isAbsolute(project.path),
    )
  ) {
    throw new Error(`Invalid Pilot project registry at ${path}`);
  }
  return value as ProjectRegistryFile;
}

function summary(path: string): Project {
  return {
    id: projectId(path),
    name: basename(path) || path,
    path,
  };
}

export class ProjectService {
  private projects = new Map<string, Project>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly registryPath: string) {}

  async initialize(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (fileErrorCode(error) === "ENOENT") return;
      throw new Error(`Could not read Pilot project registry at ${this.registryPath}`, {
        cause: error,
      });
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid JSON in Pilot project registry at ${this.registryPath}`, {
        cause: error,
      });
    }
    const registry = parseRegistry(value, this.registryPath);
    const paths = [...new Set(registry.projects.map((project) => resolve(project.path)))];
    this.projects = new Map(
      paths.map((path) => {
        const project = summary(path);
        return [project.id, project];
      }),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private sorted(projects = this.projects): Project[] {
    return [...projects.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
  }

  list(): Project[] {
    return this.sorted();
  }

  private async persist(projects: Map<string, Project>): Promise<void> {
    const directory = dirname(this.registryPath);
    const temporaryPath = join(directory, `.projects-${process.pid}-${randomUUID()}.tmp`);
    const registry: ProjectRegistryFile = {
      version: 1,
      projects: this.sorted(projects).map((project) => ({ path: project.path })),
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.registryPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  add(path: string): Promise<Project> {
    return this.queueMutation(async () => {
      const canonical = await canonicalDirectory(path, "add");
      const project = summary(canonical);
      if (this.projects.has(project.id)) {
        throw new AppError(409, "project_already_added", "This project is already in Pilot");
      }
      const next = new Map(this.projects);
      next.set(project.id, project);
      await this.persist(next);
      this.projects = next;
      this.notify();
      return project;
    });
  }

  remove(id: string): Promise<Project> {
    return this.queueMutation(async () => {
      const project = this.lookup(id);
      const next = new Map(this.projects);
      next.delete(id);
      await this.persist(next);
      this.projects = next;
      this.notify();
      return project;
    });
  }

  private lookup(id: string): Project {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) {
      throw new AppError(400, "invalid_project", "Invalid project identifier");
    }
    const project = this.projects.get(id);
    if (!project) {
      throw new AppError(404, "project_not_found", "Project is not in Pilot");
    }
    return project;
  }

  async get(id: string): Promise<Project> {
    const project = this.lookup(id);
    const canonical = await realpath(project.path).catch(() => undefined);
    const info = canonical ? await stat(canonical).catch(() => undefined) : undefined;
    if (canonical !== project.path || !info?.isDirectory()) {
      throw new AppError(
        404,
        "project_unavailable",
        "Project directory is no longer available on the server",
      );
    }
    return project;
  }
}

export async function listDirectories(requestedPath?: string): Promise<DirectoryListing> {
  const canonical = await canonicalDirectory(requestedPath ?? homedir(), "browse");
  let entries: Dirent[];
  try {
    entries = await readdir(canonical, { withFileTypes: true });
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new AppError(403, "directory_forbidden", "Pilot cannot list this directory");
    }
    throw error;
  }

  const directories = (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return undefined;
        const visiblePath = join(canonical, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await stat(visiblePath).catch(() => undefined);
          if (!target?.isDirectory()) return undefined;
        }
        return {
          name: entry.name,
          path: visiblePath,
          symlink: entry.isSymbolicLink(),
          hidden: entry.name.startsWith("."),
        };
      }),
    )
  )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
  const root = parse(canonical).root;
  const parent = dirname(canonical);
  return {
    path: canonical,
    ...(parent !== canonical ? { parent } : {}),
    home: homedir(),
    root,
    directories,
  };
}
