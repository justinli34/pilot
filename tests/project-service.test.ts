import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listDirectories, ProjectService } from "../src/server/project-service.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "pilot-projects-"));
  const alpha = join(base, "alpha");
  const registry = join(base, "pilot-data", "projects.json");
  await mkdir(alpha);
  return { base, alpha, registry };
}

describe("ProjectService", () => {
  it("starts empty and persists explicitly added project folders", async () => {
    const { alpha, registry } = await fixture();
    const service = new ProjectService(registry);
    await service.initialize();
    expect(service.list()).toEqual([]);

    const project = await service.add(alpha);
    expect(service.list()).toEqual([project]);
    expect(project).toMatchObject({ name: "alpha", path: alpha });

    const restarted = new ProjectService(registry);
    await restarted.initialize();
    expect(restarted.list()).toEqual([project]);
    expect(JSON.parse(await readFile(registry, "utf8"))).toEqual({
      version: 1,
      projects: [{ path: alpha }],
    });
  });

  it("rejects duplicate and relative project paths", async () => {
    const { alpha, registry } = await fixture();
    const service = new ProjectService(registry);
    await service.initialize();
    await service.add(alpha);
    await expect(service.add(alpha)).rejects.toMatchObject({ code: "project_already_added" });
    await expect(service.add("relative/project")).rejects.toMatchObject({
      code: "invalid_project_path",
    });
  });

  it("removes a project from Pilot without deleting its directory", async () => {
    const { alpha, registry } = await fixture();
    const service = new ProjectService(registry);
    await service.initialize();
    const project = await service.add(alpha);

    await expect(service.remove(project.id)).resolves.toEqual(project);
    expect(service.list()).toEqual([]);
    await expect(access(alpha)).resolves.toBeUndefined();
  });

  it("browses directories without returning files", async () => {
    const { base, alpha } = await fixture();
    await mkdir(join(base, ".hidden"));
    await writeFile(join(base, "notes.txt"), "not a directory");
    await symlink(alpha, join(base, "alpha-link"));

    const listing = await listDirectories(base);
    expect(listing.path).toBe(base);
    expect(listing.directories.map((directory) => directory.name)).toEqual([
      ".hidden",
      "alpha",
      "alpha-link",
    ]);
    expect(listing.directories.find((directory) => directory.name === ".hidden")?.hidden).toBe(
      true,
    );
    expect(listing.directories.find((directory) => directory.name === "alpha-link")?.symlink).toBe(
      true,
    );
  });
});
