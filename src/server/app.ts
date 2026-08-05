import { access, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import {
  AddProjectRequestSchema,
  UpdateSessionRequestSchema,
  type ApiErrorResponse,
  type CreateSessionResponse,
  type DeleteProjectResponse,
  type DeleteSessionResponse,
  type DirectoryListing,
  type ProjectResponse,
  type ProjectsResponse,
  type SessionsResponse,
  type SessionSummary,
  type UpdateSessionResponse,
} from "../shared/protocol.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { DEFAULT_PAGE_SIZE, pageSize, projectPage, sessionPage } from "./pagination.js";
import { listDirectories, ProjectService, type Project } from "./project-service.js";
import { RuntimeHost } from "./runtime-host.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { safeLogMessage, truncateUtf8 } from "./security.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionTitleGenerator } from "./session-title-generator.js";
import { WorkspaceSessionsStreamHub } from "./workspace-sessions-stream.js";

interface ProjectParams {
  projectId: string;
}
interface SessionParams extends ProjectParams {
  sessionId: string;
}
interface SessionSocketQuery {
  revision?: string;
}
interface PageQuery {
  cursor?: string;
  limit?: string;
}
interface DirectoryQuery {
  path?: string;
}

function cachedRevision(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9:-]{1,128}$/.test(value) ? value : undefined;
}

function normalizeRequestOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isDevelopmentLoopbackOrigin(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  );
}

export function sessionOpenCloseCode(error: unknown): 1008 | 1011 {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
    ? 1008
    : 1011;
}

function sessionSummary(
  info: Awaited<ReturnType<SessionCatalog["list"]>>["sessions"][number],
  project: Project,
  registry: RuntimeRegistry,
): SessionSummary {
  const runtime = registry.status(info.id);
  return {
    id: info.id,
    projectId: project.id,
    ...(info.name ? { name: truncateUtf8(info.name, 512, "…") } : {}),
    firstMessage: truncateUtf8(info.firstMessage || "New session", 512, "…"),
    createdAt: info.created.toISOString(),
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    archived: info.archived,
    unread: registry.isUnread(info.id),
    status: runtime.status,
    phase: runtime.phase,
  };
}

async function sessionsResponse(
  project: Project,
  catalog: SessionCatalog,
  registry: RuntimeRegistry,
  cursor?: string,
  limit = DEFAULT_PAGE_SIZE,
): Promise<SessionsResponse> {
  const result = await catalog.list(project);
  const page = sessionPage(result.sessions, cursor, limit);
  return {
    sessions: page.items.map((info) => sessionSummary(info, project, registry)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  if (config.production) {
    await mkdir(dirname(config.logFile), { recursive: true, mode: 0o700 });
    const logFile = await open(config.logFile, "a", 0o600);
    await logFile.close();
  }

  const app = Fastify({
    bodyLimit: 32 * 1024,
    trustProxy: "127.0.0.1",
    logger: {
      level: config.logLevel,
      ...(config.production ? { file: config.logFile } : {}),
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          "res.headers['set-cookie']",
          "*.apiKey",
          "*.password",
          "*.secret",
          "*.token",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  const projects = new ProjectService(config.projectsPath);
  await projects.initialize();
  const catalog = new SessionCatalog(app.log);
  const titleGenerator = config.titleGeneration
    ? new SessionTitleGenerator(config.titleGeneration)
    : undefined;
  const registry = new RuntimeRegistry(
    catalog,
    config.runtimeIdleMs,
    config.maxRuntimes,
    config.runtimeCacheBytes,
    app.log,
    (options) => RuntimeHost.create({ ...options, titleGenerator }),
  );
  const workspaceSessionsStream = new WorkspaceSessionsStreamHub({
    projects,
    catalog,
    registry,
    log: app.log,
    snapshot: async () => {
      const collections = await Promise.all(
        projects.list().map(async (project) => {
          try {
            const result = await catalog.list(project);
            return result.sessions.map((info) => sessionSummary(info, project, registry));
          } catch (error) {
            app.log.warn(
              { projectId: project.id, error: safeLogMessage(error) },
              "Could not include project in workspace sessions snapshot",
            );
            return [];
          }
        }),
      );
      return collections
        .flat()
        .sort(
          (left, right) =>
            Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
            left.id.localeCompare(right.id),
        );
    },
  });

  await app.register(fastifyHelmet, {
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });

  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const normalized = normalizeRequestOrigin(origin);
      const allowed =
        normalized !== undefined &&
        (config.allowedOrigins.has(normalized) ||
          (!config.production && isDevelopmentLoopbackOrigin(normalized)));
      if (!allowed || normalized !== origin) {
        throw new AppError(403, "origin_rejected", "Request Origin is not allowed");
      }
    }
    if (request.method === "OPTIONS") {
      throw new AppError(403, "cross_origin_disabled", "Cross-origin API access is disabled");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: config.wsMaxPayloadBytes,
      // Session snapshots are mostly text and can be several MiB. Compressing frames reduces
      // transfer size; no-context-takeover keeps memory bounded.
      perMessageDeflate: {
        threshold: 1_024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        zlibDeflateOptions: { level: 3 },
      },
      clientTracking: true,
    },
    errorHandler(error, socket, request) {
      request.log.warn({ error: safeLogMessage(error) }, "WebSocket route error");
      socket.close(1011, "Session connection failed");
    },
  });

  app.get("/api/v1/health", async () => ({ ok: true }));

  app.get<{ Querystring: PageQuery; Reply: ProjectsResponse }>(
    "/api/v1/projects",
    async (request) => {
      const page = projectPage(
        projects.list(),
        request.query.cursor,
        pageSize(request.query.limit),
      );
      return {
        projects: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );

  app.post<{ Body: unknown; Reply: ProjectResponse }>(
    "/api/v1/projects",
    async (request, reply) => {
      const parsed = AddProjectRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "invalid_project_path",
          parsed.error.issues[0]?.message ?? "Invalid project path",
        );
      }
      const project = await projects.add(parsed.data.path);
      reply.code(201);
      return { project };
    },
  );

  app.get<{ Querystring: DirectoryQuery; Reply: DirectoryListing }>(
    "/api/v1/filesystem/directories",
    async (request) => {
      const path = request.query.path;
      if (path !== undefined && (typeof path !== "string" || path.length > 4_096)) {
        throw new AppError(400, "invalid_directory", "Invalid directory path");
      }
      return listDirectories(path);
    },
  );

  app.get("/api/v1/sessions/ws", { websocket: true }, async (socket, request) => {
    try {
      await workspaceSessionsStream.attach(socket);
    } catch (error) {
      request.log.error(
        { error: safeLogMessage(error) },
        "Workspace sessions WebSocket initialization failed",
      );
      if (socket.readyState === socket.OPEN) {
        socket.close(sessionOpenCloseCode(error), "Unable to stream workspace sessions");
      }
    }
  });

  app.get<{ Params: ProjectParams; Reply: ProjectResponse }>(
    "/api/v1/projects/:projectId",
    async (request) => ({ project: await projects.get(request.params.projectId) }),
  );

  app.delete<{ Params: ProjectParams; Reply: DeleteProjectResponse }>(
    "/api/v1/projects/:projectId",
    async (request) => {
      await registry.releaseProject(request.params.projectId);
      const project = await projects.remove(request.params.projectId);
      return { removed: true, projectId: project.id };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: PageQuery; Reply: SessionsResponse }>(
    "/api/v1/projects/:projectId/sessions",
    async (request) => {
      const project = await projects.get(request.params.projectId);
      return sessionsResponse(
        project,
        catalog,
        registry,
        request.query.cursor,
        pageSize(request.query.limit),
      );
    },
  );

  app.post<{ Params: ProjectParams; Reply: CreateSessionResponse }>(
    "/api/v1/projects/:projectId/sessions",
    async (request, reply) => {
      const project = await projects.get(request.params.projectId);
      const host = await registry.create(project);
      const info = await catalog.find(project, host.sessionId);
      reply.code(201);
      return { session: sessionSummary(info, project, registry) };
    },
  );

  app.get<{ Params: SessionParams; Reply: UpdateSessionResponse }>(
    "/api/v1/projects/:projectId/sessions/:sessionId",
    async (request) => {
      const project = await projects.get(request.params.projectId);
      const info = await catalog.find(project, request.params.sessionId);
      return { session: sessionSummary(info, project, registry) };
    },
  );

  app.patch<{ Params: SessionParams; Body: unknown; Reply: UpdateSessionResponse }>(
    "/api/v1/projects/:projectId/sessions/:sessionId",
    async (request) => {
      const parsed = UpdateSessionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const isRename =
          typeof request.body === "object" &&
          request.body !== null &&
          !Array.isArray(request.body) &&
          "name" in request.body;
        throw new AppError(
          400,
          isRename ? "invalid_session_name" : "invalid_session_update",
          parsed.error.issues[0]?.message ??
            (isRename ? "Invalid session name" : "Invalid session update"),
        );
      }
      const project = await projects.get(request.params.projectId);
      const info = await catalog.find(project, request.params.sessionId);
      const updated =
        "name" in parsed.data
          ? await registry.renameSession(project, info, parsed.data.name.trim())
          : "archived" in parsed.data
            ? await registry.setSessionArchived(project, info, parsed.data.archived)
            : info;
      if ("unread" in parsed.data) registry.markSessionRead(project.id, info.id);
      return { session: sessionSummary(updated, project, registry) };
    },
  );

  app.delete<{ Params: SessionParams; Reply: DeleteSessionResponse }>(
    "/api/v1/projects/:projectId/sessions/:sessionId",
    async (request) => {
      const project = await projects.get(request.params.projectId);
      const info = await catalog.find(project, request.params.sessionId);
      await registry.deleteSession(project, info);
      return { deleted: true, sessionId: request.params.sessionId };
    },
  );

  app.get<{ Params: SessionParams; Querystring: SessionSocketQuery }>(
    "/api/v1/projects/:projectId/sessions/:sessionId/ws",
    { websocket: true },
    async (socket, request) => {
      try {
        const project = await projects.get(request.params.projectId);
        const info = await catalog.find(project, request.params.sessionId);
        const host = await registry.open(project, info);
        host.attach(socket, { revision: cachedRevision(request.query.revision) });
      } catch (error) {
        const detail =
          error instanceof AppError
            ? `Open session failed: ${error.message}`
            : "Open session failed. Check the Pilot server log for details.";
        request.log.error(
          {
            projectId: request.params.projectId,
            sessionId: request.params.sessionId,
            error: safeLogMessage(error),
          },
          "WebSocket session initialization failed",
        );
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              kind: "event",
              sessionId: request.params.sessionId,
              sequence: 1,
              event: { type: "notification", tone: "error", message: detail },
            }),
          );
          socket.close(sessionOpenCloseCode(error), "Unable to open this session");
        }
      }
    },
  );

  let hasClient = false;
  try {
    await access(`${config.clientDist}/index.html`);
    hasClient = true;
  } catch {
    if (config.production)
      throw new Error(`Production client assets are missing from ${config.clientDist}`);
  }

  if (hasClient) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: "/",
      wildcard: false,
      index: false,
      dotfiles: "deny",
      preCompressed: true,
      setHeaders(response, path) {
        if (path.endsWith("sw.js")) {
          response.header("Cache-Control", "no-cache");
          response.header("Service-Worker-Allowed", "/");
        } else if (path.endsWith("index.html") || path.endsWith("manifest.webmanifest")) {
          response.header("Cache-Control", "no-cache");
        } else if (path.includes("/assets/")) {
          response.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "API route not found", requestId: request.id },
      });
    }
    if (hasClient && request.method === "GET" && request.headers.accept?.includes("text/html")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply
      .code(404)
      .send({ error: { code: "not_found", message: "Not found", requestId: request.id } });
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const known = error instanceof AppError;
    const genericError = error instanceof Error ? error : new Error("Unknown request error");
    const reportedStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const statusCode = known
      ? error.statusCode
      : reportedStatus && reportedStatus < 500
        ? reportedStatus
        : 500;
    const code = known ? error.code : statusCode < 500 ? "bad_request" : "internal_error";
    const message = known
      ? error.message
      : statusCode < 500
        ? truncateUtf8(genericError.message, 2_048, "…")
        : "The server could not complete this action";
    if (statusCode >= 500) {
      request.log.error(
        {
          requestId: request.id,
          method: request.method,
          url: request.url,
          error: safeLogMessage(error),
        },
        "Request failed",
      );
    } else {
      request.log.info({ requestId: request.id, code, statusCode }, "Request rejected");
    }
    const body: ApiErrorResponse = { error: { code, message, requestId: request.id } };
    return reply.code(statusCode).send(body);
  });

  app.addHook("onClose", async () => {
    workspaceSessionsStream.closeAll();
    catalog.close();
    await registry.disposeAll();
  });
  return app;
}
