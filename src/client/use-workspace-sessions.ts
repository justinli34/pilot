import { useCallback, useEffect, useState } from "react";

import { parseWorkspaceSessionsStreamEnvelope, type SessionSummary } from "../shared/protocol.js";

interface WorkspaceSessionsState {
  sessions: SessionSummary[];
  loading: boolean;
  error?: string;
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.sort(
    (left, right) =>
      Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) || left.id.localeCompare(right.id),
  );
}

export function reconcileWorkspaceSessions(
  current: SessionSummary[],
  incoming: SessionSummary[],
): SessionSummary[] {
  const previous = new Map(current.map((session) => [session.id, session]));
  return sortSessions(
    incoming.map((session) => {
      const existing = previous.get(session.id);
      return existing && JSON.stringify(existing) === JSON.stringify(session) ? existing : session;
    }),
  );
}

function workspaceSessionsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/sessions/ws`;
}

export function useWorkspaceSessions() {
  const [state, setState] = useState<WorkspaceSessionsState>({ sessions: [], loading: true });

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let receivedSnapshot = false;
    let protocolFailed = false;

    const scheduleReconnect = (error: string) => {
      if (stopped || reconnectTimer !== undefined) return;
      setState((current) => ({
        ...current,
        loading: !receivedSnapshot,
        error,
      }));
      attempt += 1;
      const delay =
        Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 250);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      let current: WebSocket;
      try {
        current = new WebSocket(workspaceSessionsUrl());
      } catch {
        scheduleReconnect("Could not load sessions. Retrying…");
        return;
      }
      socket = current;
      current.addEventListener("message", (message) => {
        if (stopped || current !== socket || typeof message.data !== "string") return;
        try {
          const envelope = parseWorkspaceSessionsStreamEnvelope(message.data);
          receivedSnapshot = true;
          attempt = 0;
          setState((existing) => ({
            sessions: reconcileWorkspaceSessions(existing.sessions, envelope.sessions),
            loading: false,
          }));
        } catch {
          protocolFailed = true;
          setState((existing) => ({
            ...existing,
            loading: false,
            error: "Pilot may have been updated. Close and reopen the app.",
          }));
          current.close(4000, "Incompatible server message");
        }
      });
      current.addEventListener("close", (event) => {
        if (current === socket) socket = undefined;
        if (stopped || protocolFailed) return;
        if (event.code === 1008) {
          setState((existing) => ({
            ...existing,
            loading: false,
            error: event.reason || "The sessions stream was rejected.",
          }));
          return;
        }
        scheduleReconnect(
          receivedSnapshot
            ? "Session updates disconnected. Reconnecting…"
            : "Could not load sessions. Retrying…",
        );
      });
      current.addEventListener("error", () => {
        // The close event drives reconnection.
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, "Workspace closed");
      }
    };
  }, []);

  const upsertSession = useCallback((session: SessionSummary) => {
    setState((current) => ({
      ...current,
      sessions: sortSessions([
        session,
        ...current.sessions.filter((candidate) => candidate.id !== session.id),
      ]),
    }));
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
    }));
  }, []);

  const removeProjectSessions = useCallback((projectId: string) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.projectId !== projectId),
    }));
  }, []);

  return { ...state, upsertSession, removeSession, removeProjectSessions };
}
