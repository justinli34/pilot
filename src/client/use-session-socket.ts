import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  TRANSCRIPT_LIMIT_NOTICE_ID,
  parseServerEnvelope,
  type ClientCommand,
  type JsonValue,
  type ServerEvent,
  type SessionSnapshot,
} from "../shared/protocol.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

interface PendingRequest {
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface CachedSession {
  snapshot: SessionSnapshot;
  revision?: string;
  bytes: number;
}

const MAX_CACHED_SESSION_BYTES = 24 * 1024 * 1024;
const MAX_CACHED_SESSION_ENTRIES = 4;
const snapshotCache = new Map<string, CachedSession>();
const snapshotByteEstimates = new WeakMap<SessionSnapshot, number>();
const textEncoder = new TextEncoder();

function sessionCacheKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

export function forgetSessionSnapshot(projectId: string, sessionId: string): void {
  snapshotCache.delete(sessionCacheKey(projectId, sessionId));
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export function estimateSessionSnapshotBytes(snapshot: SessionSnapshot): number {
  const cached = snapshotByteEstimates.get(snapshot);
  if (cached !== undefined) return cached;
  const bytes = jsonBytes(snapshot);
  snapshotByteEstimates.set(snapshot, bytes);
  return bytes;
}

function cacheSession(key: string, value: CachedSession): void {
  snapshotCache.delete(key);
  if (value.bytes > MAX_CACHED_SESSION_BYTES) return;
  snapshotCache.set(key, value);
  let totalBytes = [...snapshotCache.values()].reduce((total, entry) => total + entry.bytes, 0);
  while (snapshotCache.size > MAX_CACHED_SESSION_ENTRIES || totalBytes > MAX_CACHED_SESSION_BYTES) {
    const oldest = snapshotCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) break;
    const removed = snapshotCache.get(oldest);
    snapshotCache.delete(oldest);
    totalBytes -= removed?.bytes ?? 0;
  }
}

function replaceValueBytes(
  bytes: number,
  previousValues: readonly unknown[],
  nextValues: readonly unknown[],
): number {
  const previousBytes = previousValues.reduce<number>(
    (total, value) => total + jsonBytes(value),
    0,
  );
  const nextBytes = nextValues.reduce<number>((total, value) => total + jsonBytes(value), 0);
  return Math.max(0, bytes - previousBytes + nextBytes);
}

function transcriptDeltaBytes(
  bytes: number,
  previous: SessionSnapshot,
  next: SessionSnapshot,
  event: Extract<ServerEvent, { type: "transcript_delta" }>,
): number {
  const changedTranscriptIds = new Set([
    TRANSCRIPT_LIMIT_NOTICE_ID,
    ...event.removedIds,
    ...event.appended.map((item) => item.id),
    ...(event.notice ? [event.notice.id] : []),
  ]);
  let previousBytes = 0;
  let nextBytes = 0;
  for (const item of previous.transcript) {
    if (changedTranscriptIds.has(item.id)) previousBytes += jsonBytes(item);
  }
  for (const item of next.transcript) {
    if (changedTranscriptIds.has(item.id)) nextBytes += jsonBytes(item);
  }

  const changedToolIds = new Set([...Object.keys(event.toolUpserts), ...event.removedToolIds]);
  for (const id of changedToolIds) {
    previousBytes += jsonBytes(previous.tools[id]);
    nextBytes += jsonBytes(next.tools[id]);
  }
  return Math.max(0, bytes - previousBytes + nextBytes);
}

export function updatedSnapshotBytes(
  bytes: number,
  previous: SessionSnapshot | undefined,
  next: SessionSnapshot,
  event: ServerEvent,
  serializedCharacters: number,
): number {
  if (!previous || event.type === "snapshot") {
    // Browser strings use up to two bytes per character. The envelope length is a cheap,
    // conservative cache weight and avoids serializing a multi-MiB snapshot a second time.
    return serializedCharacters * 2;
  }
  if (previous === next) return bytes;
  switch (event.type) {
    case "assistant_delta":
      return bytes + jsonBytes(event.append) - 2;
    case "assistant_updated":
      return replaceValueBytes(bytes, [previous.streamingMessage], [next.streamingMessage]);
    case "tool_delta":
      return (
        bytes + jsonBytes(event.outputAppend ?? "") - 2 + jsonBytes(event.patchAppend ?? "") - 2
      );
    case "tool_updated":
      return replaceValueBytes(bytes, [previous.tools[event.tool.id]], [next.tools[event.tool.id]]);
    case "transcript_delta":
      return transcriptDeltaBytes(bytes, previous, next, event);
    case "queue_updated":
      return replaceValueBytes(
        bytes,
        [previous.queue, previous.runtime],
        [next.queue, next.runtime],
      );
    case "runtime_updated":
      return replaceValueBytes(
        bytes,
        [
          previous.runtime,
          previous.currentModel,
          previous.thinkingLevel,
          previous.thinkingLevels,
          previous.contextUsage,
        ],
        [
          next.runtime,
          next.currentModel,
          next.thinkingLevel,
          next.thinkingLevels,
          next.contextUsage,
        ],
      );
    case "transcript_updated":
      // A replacement has no compact delta to account from, so measure it only on this rare path.
      return estimateSessionSnapshotBytes(next);
    case "notification":
    case "session_ready":
      return bytes;
  }
}

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function shouldReconnect(code: number): boolean {
  return code !== 1008;
}

function websocketUrl(projectId: string, sessionId: string, revision?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/ws`;
  const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
  return `${protocol}//${window.location.host}${path}${query}`;
}

function applyTranscriptDelta(
  snapshot: SessionSnapshot,
  event: Extract<ServerEvent, { type: "transcript_delta" }>,
): SessionSnapshot {
  const removed = new Set(event.removedIds);
  const transcript = snapshot.transcript.filter(
    (item) => item.id !== TRANSCRIPT_LIMIT_NOTICE_ID && !removed.has(item.id),
  );
  const known = new Set(transcript.map((item) => item.id));
  for (const item of event.appended) {
    if (!known.has(item.id)) transcript.push(item);
  }

  const tools = { ...snapshot.tools, ...event.toolUpserts };
  for (const id of event.removedToolIds) delete tools[id];
  return {
    ...snapshot,
    transcript: event.notice ? [event.notice, ...transcript] : transcript,
    tools,
    truncated: event.truncated,
  };
}

export function applySessionEvent(
  snapshot: SessionSnapshot | undefined,
  event: ServerEvent,
): SessionSnapshot | undefined {
  if (event.type === "snapshot") return event.snapshot;
  if (!snapshot) return snapshot;
  switch (event.type) {
    case "session_ready":
      return snapshot;
    case "transcript_updated":
      return {
        ...snapshot,
        transcript: event.transcript,
        tools: event.tools,
        truncated: event.truncated,
      };
    case "transcript_delta":
      return applyTranscriptDelta(snapshot, event);
    case "assistant_updated":
      return { ...snapshot, streamingMessage: event.message };
    case "assistant_delta": {
      const message = snapshot.streamingMessage;
      const block = message?.blocks[event.blockIndex];
      if (!message || message.id !== event.messageId || !block || block.type !== event.field) {
        return snapshot;
      }
      const blocks = [...message.blocks];
      blocks[event.blockIndex] =
        block.type === "text"
          ? { ...block, text: block.text + event.append }
          : { ...block, thinking: block.thinking + event.append };
      return { ...snapshot, streamingMessage: { ...message, blocks } };
    }
    case "tool_updated":
      return { ...snapshot, tools: { ...snapshot.tools, [event.tool.id]: event.tool } };
    case "tool_delta": {
      const tool = snapshot.tools[event.toolId];
      if (!tool) return snapshot;
      return {
        ...snapshot,
        tools: {
          ...snapshot.tools,
          [event.toolId]: {
            ...tool,
            output: tool.output + (event.outputAppend ?? ""),
            ...((tool.patch !== undefined || event.patchAppend !== undefined) && {
              patch: (tool.patch ?? "") + (event.patchAppend ?? ""),
            }),
          },
        },
      };
    }
    case "queue_updated":
      return {
        ...snapshot,
        queue: event.queue,
        runtime: { ...snapshot.runtime, queueDepth: event.queue.messages.length },
      };
    case "runtime_updated":
      return {
        ...snapshot,
        runtime: event.runtime,
        currentModel: event.currentModel,
        thinkingLevel: event.thinkingLevel,
        thinkingLevels: event.thinkingLevels,
        contextUsage: event.contextUsage,
      };
    case "notification":
      return snapshot;
  }
}

interface KeyedSessionState {
  key?: string;
  snapshot?: SessionSnapshot;
  revision?: string;
}

interface KeyedConnectionState {
  key?: string;
  value: ConnectionState;
}

interface KeyedNotificationState {
  key?: string;
  value?: Extract<ServerEvent, { type: "notification" }>;
}

export function useSessionSocket(projectId: string | undefined, sessionId: string | undefined) {
  const activeKey = projectId && sessionId ? sessionCacheKey(projectId, sessionId) : undefined;
  const [sessionState, setSessionState] = useState<KeyedSessionState>({});
  const [connectionState, setConnectionState] = useState<KeyedConnectionState>({
    value: "disconnected",
  });
  const [notificationState, setNotificationState] = useState<KeyedNotificationState>({});
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!projectId || !sessionId || !activeKey) {
      setSessionState({});
      setNotificationState({});
      setConnectionState({ value: "disconnected" });
      return;
    }

    const cached = snapshotCache.get(activeKey);
    if (cached) {
      snapshotCache.delete(activeKey);
      snapshotCache.set(activeKey, cached);
    }
    let currentSnapshot = cached?.snapshot;
    let currentRevision = cached?.revision;
    let currentSnapshotBytes = cached?.bytes ?? 0;
    setSessionState({ key: activeKey, snapshot: currentSnapshot, revision: currentRevision });
    setNotificationState({ key: activeKey });
    setConnectionState({ key: activeKey, value: "connecting" });

    let stopped = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let protocolFailed = false;

    const rejectPending = (message: string) => {
      for (const pending of pendingRef.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new CommandError("connection_lost", message));
      }
      pendingRef.current.clear();
    };

    const connect = () => {
      if (stopped || generation !== generationRef.current) return;
      setConnectionState({
        key: activeKey,
        value: attempt === 0 ? "connecting" : "reconnecting",
      });
      let lastSequence = 0;
      const socket = new WebSocket(websocketUrl(projectId, sessionId, currentRevision));
      socketRef.current = socket;

      socket.addEventListener("message", (message) => {
        if (stopped || generation !== generationRef.current || typeof message.data !== "string")
          return;
        let value;
        try {
          value = parseServerEnvelope(message.data);
        } catch {
          protocolFailed = true;
          setNotificationState({
            key: activeKey,
            value: {
              type: "notification",
              tone: "error",
              message: "Pilot may have been updated. Close and reopen the app.",
            },
          });
          socket.close(4000, "Incompatible server message");
          return;
        }
        if (value.sessionId !== sessionId || value.sequence <= lastSequence) return;
        lastSequence = value.sequence;
        if (value.kind === "response") {
          const pending = pendingRef.current.get(value.requestId);
          if (!pending) return;
          pendingRef.current.delete(value.requestId);
          window.clearTimeout(pending.timeout);
          if (value.ok) pending.resolve(value.result);
          else pending.reject(new CommandError(value.error.code, value.error.message));
          return;
        }

        const previousSnapshot = currentSnapshot;
        currentSnapshot = applySessionEvent(currentSnapshot, value.event);
        currentRevision = value.revision ?? currentRevision;
        if (currentSnapshot) {
          currentSnapshotBytes = updatedSnapshotBytes(
            currentSnapshotBytes,
            previousSnapshot,
            currentSnapshot,
            value.event,
            message.data.length,
          );
          snapshotByteEstimates.set(currentSnapshot, currentSnapshotBytes);
          cacheSession(activeKey, {
            snapshot: currentSnapshot,
            revision: currentRevision,
            bytes: currentSnapshotBytes,
          });
        }
        const updateSessionState = () =>
          setSessionState({
            key: activeKey,
            snapshot: currentSnapshot,
            revision: currentRevision,
          });
        if (
          value.event.type === "assistant_updated" ||
          value.event.type === "assistant_delta" ||
          value.event.type === "tool_updated" ||
          value.event.type === "tool_delta"
        ) {
          startTransition(updateSessionState);
        } else {
          updateSessionState();
        }

        if (value.event.type === "snapshot" || value.event.type === "session_ready") {
          if (!currentSnapshot) {
            socket.close(1002, "Cached session snapshot is unavailable");
            return;
          }
          attempt = 0;
          setConnectionState({ key: activeKey, value: "connected" });
          setNotificationState({ key: activeKey });
        }
        if (value.event.type === "notification") {
          setNotificationState({ key: activeKey, value: value.event });
        }
      });

      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) socketRef.current = undefined;
        if (stopped || generation !== generationRef.current) return;
        rejectPending(
          "Connection closed before the command response arrived. The server-side run may still continue.",
        );
        if (protocolFailed) {
          setConnectionState({ key: activeKey, value: "disconnected" });
          return;
        }
        if (!shouldReconnect(event.code)) {
          setConnectionState({ key: activeKey, value: "disconnected" });
          if (event.code === 1008) {
            setNotificationState((current) =>
              current.key === activeKey && current.value?.tone === "error"
                ? current
                : {
                    key: activeKey,
                    value: {
                      type: "notification",
                      tone: "error",
                      message: event.reason || "Unable to open this session",
                    },
                  },
            );
          }
          return;
        }
        setConnectionState({ key: activeKey, value: "reconnecting" });
        attempt += 1;
        const delay =
          Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 250);
        reconnectTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        // close drives the reconnect path and avoids showing duplicate errors.
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      rejectPending("Session view changed before the command completed");
      const socket = socketRef.current;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, "Session view closed");
      }
      if (socketRef.current === socket) socketRef.current = undefined;
      setConnectionState({ key: activeKey, value: "disconnected" });
    };
  }, [activeKey, projectId, sessionId]);

  const sendCommand = useCallback((command: ClientCommand): Promise<JsonValue | undefined> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new CommandError("not_connected", "The session is reconnecting. Try again when connected."),
      );
    }
    const requestId = crypto.randomUUID();
    const timeoutMs = command.type === "prompt" ? 10 * 60_000 : 30_000;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(
          new CommandError("command_timeout", "The server did not acknowledge the command in time"),
        );
      }, timeoutMs);
      pendingRef.current.set(requestId, { resolve, reject, timeout });
      try {
        socket.send(
          JSON.stringify({
            kind: "command",
            requestId,
            command,
          }),
        );
      } catch (error) {
        window.clearTimeout(timeout);
        pendingRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error("Could not send command"));
      }
    });
  }, []);

  const cached = activeKey ? snapshotCache.get(activeKey) : undefined;
  const snapshot = sessionState.key === activeKey ? sessionState.snapshot : cached?.snapshot;
  const connection =
    connectionState.key === activeKey
      ? connectionState.value
      : activeKey
        ? "connecting"
        : "disconnected";
  const notification = notificationState.key === activeKey ? notificationState.value : undefined;

  return { snapshot, connection, notification, sendCommand };
}
