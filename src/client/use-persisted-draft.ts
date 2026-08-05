import { useCallback, useEffect, useRef, useState } from "react";

const textEncoder = new TextEncoder();

function draftKey(sessionId: string): string {
  return `pilot.draft.${sessionId}`;
}

function persistDraft(sessionId: string, draft: string): void {
  if (draft) localStorage.setItem(draftKey(sessionId), draft);
  else localStorage.removeItem(draftKey(sessionId));
}

export function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function usePersistedDraft(sessionId: string) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(sessionId)) ?? "");
  const [bytes, setBytes] = useState(() => utf8Bytes(draft));
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  useEffect(() => {
    const timer = window.setTimeout(() => persistDraft(sessionId, draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft, sessionId]);

  useEffect(
    () => () => {
      persistDraft(sessionId, latestDraft.current);
    },
    [sessionId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setBytes(utf8Bytes(draft)), 100);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const clearDraft = useCallback(() => {
    setDraft("");
    setBytes(0);
    localStorage.removeItem(draftKey(sessionId));
  }, [sessionId]);

  return { draft, setDraft, bytes, clearDraft };
}
