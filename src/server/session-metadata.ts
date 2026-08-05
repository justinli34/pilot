import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const PILOT_SESSION_STATE_CUSTOM_TYPE = "pilot.session-state";

interface PilotSessionState {
  version: 1;
  archived: boolean;
}

export function sessionArchiveValue(entry: Record<string, unknown>): boolean | undefined {
  if (entry.type !== "custom" || entry.customType !== PILOT_SESSION_STATE_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const archived = (data as Record<string, unknown>).archived;
  return typeof archived === "boolean" ? archived : undefined;
}

export function appendSessionArchiveState(manager: SessionManager, archived: boolean): string {
  const state: PilotSessionState = { version: 1, archived };
  return manager.appendCustomEntry(PILOT_SESSION_STATE_CUSTOM_TYPE, state);
}
