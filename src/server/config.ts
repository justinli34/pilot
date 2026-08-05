import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod/mini";

const HOST = "127.0.0.1" as const;
const CLIENT_DIST = fileURLToPath(new URL("../../client", import.meta.url));
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const IntegerSchema = (minimum: number, maximum: number) =>
  z.number().check(z.int(), z.gte(minimum), z.lte(maximum));

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an exact HTTP(S) origin");
  }
  return url.origin;
}

function isOrigin(value: string): boolean {
  try {
    normalizeOrigin(value);
    return true;
  } catch {
    return false;
  }
}

const AdvancedConfigSchema = z.strictObject({
  runtimeIdleMinutes: z.optional(IntegerSchema(1, 24 * 60)),
  maxRuntimes: z.optional(IntegerSchema(1, 256)),
  runtimeCacheMiB: z.optional(IntegerSchema(16, 4_096)),
});

const ModelReferenceValueSchema = z.string().check(
  z.minLength(1),
  z.maxLength(256),
  z.refine((value) => value.trim().length > 0, "Model provider and ID cannot be blank"),
);

const ModelReferenceSchema = z.strictObject({
  provider: ModelReferenceValueSchema,
  id: ModelReferenceValueSchema,
});

const TitleGenerationConfigSchema = z.union([
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    model: ModelReferenceSchema,
    maxCharacters: z.optional(IntegerSchema(1, 512)),
  }),
]);

const ConfigFileSchema = z.strictObject({
  port: z.optional(IntegerSchema(1, 65_535)),
  allowedOrigins: z.optional(
    z.array(z.string().check(z.refine(isOrigin, "Expected an exact HTTP(S) origin"))),
  ),
  logLevel: z.optional(z.enum(LOG_LEVELS)),
  titleGeneration: z.optional(TitleGenerationConfigSchema),
  advanced: z.optional(AdvancedConfigSchema),
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;
export type AppMode = "production" | "development";

export interface AppConfig {
  host: typeof HOST;
  port: number;
  projectsPath: string;
  allowedOrigins: ReadonlySet<string>;
  clientDist: string;
  runtimeIdleMs: number;
  maxRuntimes: number;
  runtimeCacheBytes: number;
  wsMaxPayloadBytes: number;
  titleGeneration?: {
    model: {
      provider: string;
      id: string;
    };
    maxCharacters: number;
  };
  logLevel: (typeof LOG_LEVELS)[number];
  logFile: string;
  configPath: string;
  production: boolean;
}

export interface ConfigPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface LoadConfigOptions {
  path?: string;
  mode?: AppMode;
}

export function defaultConfigPath(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === "win32") {
    const base = env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming");
    return win32.join(base, "Pilot", "config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Pilot", "config.json");
  }

  const configuredHome = env.XDG_CONFIG_HOME?.trim();
  const base =
    configuredHome && isAbsolute(configuredHome) ? configuredHome : join(home, ".config");
  return join(base, "pilot", "config.json");
}

export function defaultLogPath(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
    return win32.join(base, "Pilot", "Logs", "pilot.log");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Logs", "Pilot", "pilot.log");
  }

  const configuredHome = env.XDG_STATE_HOME?.trim();
  const base =
    configuredHome && isAbsolute(configuredHome) ? configuredHome : join(home, ".local", "state");
  return join(base, "pilot", "pilot.log");
}

function issuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "config" : path.map(String).join(".");
}

function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const noun = issue.keys.length === 1 ? "key" : "keys";
    return `Unrecognized ${noun}: ${issue.keys.join(", ")}`;
  }
  return issue.message;
}

function parseConfigFile(value: unknown): ConfigFile {
  const parsed = ConfigFileSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issuePath(issue.path)}: ${issueMessage(issue)}`)
      .join("; ");
    throw new Error(`Invalid Pilot configuration: ${details}`);
  }
  return parsed.data;
}

export function parseConfig(
  value: unknown,
  mode: AppMode = "production",
  configPath = defaultConfigPath(),
): AppConfig {
  const parsed = parseConfigFile(value);
  const port = parsed.port ?? 3210;
  const resolvedConfigPath = resolve(configPath);
  const allowedOrigins = new Set([
    normalizeOrigin(`http://127.0.0.1:${port}`),
    normalizeOrigin(`http://localhost:${port}`),
    ...(parsed.allowedOrigins ?? []).map(normalizeOrigin),
  ]);
  const advanced = parsed.advanced;

  return {
    host: HOST,
    port,
    projectsPath: join(dirname(resolvedConfigPath), "projects.json"),
    allowedOrigins,
    clientDist: CLIENT_DIST,
    runtimeIdleMs: (advanced?.runtimeIdleMinutes ?? 30) * 60_000,
    maxRuntimes: advanced?.maxRuntimes ?? 32,
    runtimeCacheBytes: (advanced?.runtimeCacheMiB ?? 128) * 1024 * 1024,
    // Holds the 10 MiB decoded image budget after base64/JSON expansion.
    wsMaxPayloadBytes: 16 * 1024 * 1024,
    ...(parsed.titleGeneration?.enabled
      ? {
          titleGeneration: {
            model: {
              provider: parsed.titleGeneration.model.provider.trim(),
              id: parsed.titleGeneration.model.id.trim(),
            },
            maxCharacters: parsed.titleGeneration.maxCharacters ?? 30,
          },
        }
      : {}),
    logLevel: parsed.logLevel ?? "info",
    logFile: defaultLogPath(),
    configPath: resolvedConfigPath,
    production: mode === "production",
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const path = options.path ? resolve(options.path) : defaultConfigPath();
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return parseConfig({}, options.mode, path);
    }
    throw new Error(`Could not read Pilot configuration at ${path}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid JSON in Pilot configuration at ${path}${detail}`, { cause: error });
  }

  try {
    return parseConfig(value, options.mode, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid configuration";
    throw new Error(`${detail} (${path})`, { cause: error });
  }
}
