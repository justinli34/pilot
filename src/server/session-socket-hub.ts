import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import type { RawData } from "ws";

import {
  ProtocolError,
  type ClientCommand,
  type JsonValue,
  type ServerEnvelope,
  type ServerEvent,
  type ServerResponseEnvelope,
  type SessionSnapshot,
  parseClientEnvelope,
} from "../shared/protocol.js";
import { AppError } from "./errors.js";
import { safeLogMessage } from "./security.js";

export interface SessionSocketHubOptions {
  sessionId: string;
  log: FastifyBaseLogger;
  context: Record<string, string>;
  snapshot: () => SessionSnapshot;
  execute: (command: ClientCommand) => Promise<JsonValue>;
  touch: () => void;
}

export interface SocketAttachOptions {
  revision?: string;
}

// A canonical snapshot can approach 12 MiB at the configured transcript, tool, and model caps.
// Permit one such frame while still bounding queued data from a persistently slow client.
export const MAX_SESSION_SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;

function socketMessageText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

export function exceedsSocketBackpressure(
  bufferedBytes: number,
  payloadBytes: number,
  maximumBytes = MAX_SESSION_SOCKET_BUFFER_BYTES,
): boolean {
  return (
    bufferedBytes > maximumBytes ||
    (payloadBytes <= maximumBytes && bufferedBytes + payloadBytes > maximumBytes)
  );
}

export class SessionSocketHub {
  private readonly clients = new Set<WebSocket>();
  private readonly revisionId = randomUUID();
  private revisionNumber = 0;
  private sequence = 0;

  constructor(private readonly options: SessionSocketHubOptions) {}

  private get revision(): string {
    return `${this.revisionId}:${this.revisionNumber}`;
  }

  private advanceRevision(): void {
    this.revisionNumber += 1;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private serialize(envelope: ServerEnvelope): string {
    return JSON.stringify(envelope);
  }

  private safeSend(socket: WebSocket, serialized: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (exceedsSocketBackpressure(socket.bufferedAmount, Buffer.byteLength(serialized))) {
      this.clients.delete(socket);
      this.options.log.warn(
        { ...this.options.context, bufferedBytes: socket.bufferedAmount },
        "Closing a slow session WebSocket client",
      );
      socket.close(1013, "Client fell behind; reconnecting");
      return;
    }
    try {
      socket.send(serialized);
    } catch (error) {
      this.options.log.debug(
        { ...this.options.context, error: safeLogMessage(error) },
        "WebSocket send failed",
      );
    }
  }

  private sendEventTo(socket: WebSocket, event: ServerEvent): void {
    this.safeSend(
      socket,
      this.serialize({
        kind: "event",
        sessionId: this.options.sessionId,
        sequence: ++this.sequence,
        revision: this.revision,
        event,
      }),
    );
  }

  broadcast(event: ServerEvent): void {
    // Revisions advance even without listeners so a returning browser can only reuse an exact,
    // fully up-to-date cached snapshot.
    this.advanceRevision();
    if (this.clients.size === 0) return;
    const serialized = this.serialize({
      kind: "event",
      sessionId: this.options.sessionId,
      sequence: ++this.sequence,
      revision: this.revision,
      event,
    });
    for (const client of this.clients) this.safeSend(client, serialized);
  }

  private respond(
    socket: WebSocket,
    requestId: string,
    response: { ok: true; result?: JsonValue } | { ok: false; code: string; message: string },
  ): void {
    const envelope: ServerResponseEnvelope = response.ok
      ? {
          kind: "response",
          sessionId: this.options.sessionId,
          sequence: ++this.sequence,
          requestId,
          ok: true,
          ...(response.result === undefined ? {} : { result: response.result }),
        }
      : {
          kind: "response",
          sessionId: this.options.sessionId,
          sequence: ++this.sequence,
          requestId,
          ok: false,
          error: { code: response.code, message: response.message },
        };
    this.safeSend(socket, this.serialize(envelope));
  }

  private async handleRawCommand(socket: WebSocket, raw: string): Promise<void> {
    this.options.touch();
    let envelope;
    try {
      envelope = parseClientEnvelope(raw);
    } catch (error) {
      const protocolError =
        error instanceof ProtocolError
          ? error
          : new ProtocolError("invalid_message", "Invalid message");
      this.respond(socket, "invalid", {
        ok: false,
        code: protocolError.code,
        message: protocolError.message,
      });
      return;
    }

    try {
      const result = await this.options.execute(envelope.command);
      this.respond(socket, envelope.requestId, { ok: true, result });
    } catch (error) {
      const publicError =
        error instanceof AppError
          ? error
          : new AppError(500, "command_failed", "Session command failed");
      this.respond(socket, envelope.requestId, {
        ok: false,
        code: publicError.code,
        message: publicError.message,
      });
    }
  }

  attach(socket: WebSocket, options: SocketAttachOptions = {}): void {
    this.options.touch();
    this.clients.add(socket);
    try {
      this.sendEventTo(
        socket,
        options.revision === this.revision
          ? { type: "session_ready" }
          : { type: "snapshot", snapshot: this.options.snapshot() },
      );
    } catch (error) {
      this.options.log.error(
        { ...this.options.context, error: safeLogMessage(error) },
        "Failed to create canonical session snapshot",
      );
      this.sendEventTo(socket, {
        type: "notification",
        tone: "error",
        message: "Load session snapshot failed. Check the Pilot server log for details.",
      });
      this.clients.delete(socket);
      socket.close(1011, "Session snapshot failed");
      return;
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text JSON messages are required");
        return;
      }
      void this.handleRawCommand(socket, socketMessageText(data)).catch((error) => {
        this.options.log.error(
          { ...this.options.context, error: safeLogMessage(error) },
          "Unhandled WebSocket command error",
        );
      });
    });
    socket.once("close", () => {
      this.clients.delete(socket);
      this.options.touch();
    });
    socket.on("error", (error) => {
      this.options.log.debug(
        { ...this.options.context, error: safeLogMessage(error) },
        "Session WebSocket error",
      );
    });
  }

  closeAll(code: number, reason: string): void {
    for (const client of this.clients) client.close(code, reason);
    this.clients.clear();
  }
}
