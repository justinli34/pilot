import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadConfig, type AppConfig, type AppMode } from "./config.js";
import { safeLogMessage } from "./security.js";

export function startupInstructions(config: Pick<AppConfig, "host" | "port" | "logFile">): string {
  const address = `http://${config.host}:${config.port}`;
  return [
    `Pilot is running at ${address}.`,
    `Logs: ${config.logFile}`,
    "Press Ctrl+C to quit.",
  ].join("\n");
}

export async function startServer(mode: AppMode): Promise<void> {
  let config: AppConfig;
  try {
    config = await loadConfig({ mode });
  } catch (error) {
    console.error(`Pilot failed to load configuration: ${safeLogMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  let app: FastifyInstance;
  try {
    app = await buildApp(config);
  } catch (error) {
    console.error(`Pilot failed to initialize: ${safeLogMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "Shutting down Pilot");
    const forceExit = setTimeout(() => {
      app.log.error("Graceful shutdown timed out");
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    try {
      await app.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      app.log.error({ error: safeLogMessage(error) }, "Graceful shutdown failed");
      process.exit(1);
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (error) => {
    app.log.error({ error: safeLogMessage(error) }, "Unhandled promise rejection");
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        address: `http://${config.host}:${config.port}`,
        projectsPath: config.projectsPath,
        allowedOrigins: [...config.allowedOrigins],
      },
      "Pilot is ready",
    );
    if (config.production) console.log(startupInstructions(config));
  } catch (error) {
    app.log.fatal({ error: safeLogMessage(error) }, "Pilot failed to start");
    await app.close().catch(() => undefined);
    if (config.production) console.error(`Pilot failed to start. See logs at ${config.logFile}`);
    process.exitCode = 1;
  }
}
