import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultConfigPath,
  defaultLogPath,
  exampleConfig,
  loadConfig,
  parseConfig,
} from "../src/server/config.js";

describe("Pilot configuration", () => {
  it("uses each OS's standard configuration directory", () => {
    expect(
      defaultConfigPath({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/var/config" },
        home: "/home/ada",
      }),
    ).toBe("/var/config/pilot/config.json");
    expect(defaultConfigPath({ platform: "linux", env: {}, home: "/home/ada" })).toBe(
      "/home/ada/.config/pilot/config.json",
    );
    expect(defaultConfigPath({ platform: "darwin", env: {}, home: "/Users/ada" })).toBe(
      "/Users/ada/Library/Application Support/Pilot/config.json",
    );
    expect(
      defaultConfigPath({
        platform: "win32",
        env: { APPDATA: String.raw`C:\Users\Ada\AppData\Roaming` },
        home: String.raw`C:\Users\Ada`,
      }),
    ).toBe(String.raw`C:\Users\Ada\AppData\Roaming\Pilot\config.json`);
  });

  it("uses each OS's standard log directory", () => {
    expect(
      defaultLogPath({
        platform: "linux",
        env: { XDG_STATE_HOME: "/var/state" },
        home: "/home/ada",
      }),
    ).toBe("/var/state/pilot/pilot.log");
    expect(defaultLogPath({ platform: "linux", env: {}, home: "/home/ada" })).toBe(
      "/home/ada/.local/state/pilot/pilot.log",
    );
    expect(defaultLogPath({ platform: "darwin", env: {}, home: "/Users/ada" })).toBe(
      "/Users/ada/Library/Logs/Pilot/pilot.log",
    );
    expect(
      defaultLogPath({
        platform: "win32",
        env: { LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local` },
        home: String.raw`C:\Users\Ada`,
      }),
    ).toBe(String.raw`C:\Users\Ada\AppData\Local\Pilot\Logs\pilot.log`);
  });

  it("loads and derives runtime values from one JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-config-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        ...exampleConfig(),
        port: 4321,
        allowedOrigins: ["https://pilot.example/"],
        titleGeneration: {
          enabled: true,
          model: { provider: "openai-codex", id: "gpt-5.6-luna" },
        },
        advanced: {
          runtimeIdleMinutes: 7,
          maxRuntimes: 8,
          runtimeCacheMiB: 64,
        },
        logLevel: "debug",
      }),
    );

    const config = await loadConfig({ path, mode: "development" });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4321,
      projectsPath: join(directory, "projects.json"),
      runtimeIdleMs: 7 * 60_000,
      runtimeCacheBytes: 64 * 1024 * 1024,
      titleGeneration: {
        model: { provider: "openai-codex", id: "gpt-5.6-luna" },
        maxCharacters: 30,
      },
      logLevel: "debug",
      production: false,
    });
    expect(config.allowedOrigins).toEqual(
      new Set(["http://127.0.0.1:4321", "http://localhost:4321", "https://pilot.example"]),
    );
  });

  it("applies defaults to omitted settings and rejects unknown or invalid settings", () => {
    expect(parseConfig({})).toMatchObject({
      port: 3210,
      runtimeIdleMs: 30 * 60_000,
      maxRuntimes: 32,
      runtimeCacheBytes: 128 * 1024 * 1024,
      logLevel: "info",
    });

    const valid = exampleConfig();
    expect(() => parseConfig({ ...valid, extra: true })).toThrow("Unrecognized key");
    expect(() => parseConfig({ ...valid, runtimeIdleMinutes: 7 })).toThrow("Unrecognized key");
    expect(() => parseConfig({ ...valid, port: 0 })).toThrow("port");
    expect(() => parseConfig({ ...valid, titleGeneration: { enabled: true } })).toThrow(
      "titleGeneration",
    );
    expect(() =>
      parseConfig({
        ...valid,
        titleGeneration: {
          enabled: true,
          model: { provider: "openai-codex", id: "gpt-5.6-luna" },
          maxCharacters: 0,
        },
      }),
    ).toThrow("maxCharacters");
    expect(() =>
      parseConfig({
        ...valid,
        titleGeneration: {
          enabled: true,
          model: { provider: " ", id: "gpt-5.6-luna" },
        },
      }),
    ).toThrow("cannot be blank");
    expect(() => parseConfig({ ...valid, projectRoots: ["/home/ada/projects"] })).toThrow(
      "Unrecognized key",
    );
  });

  it("uses defaults when the optional configuration file is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-config-missing-"));
    const path = join(directory, "config.json");
    await expect(loadConfig({ path })).resolves.toMatchObject({ port: 3210, maxRuntimes: 32 });
  });
});
