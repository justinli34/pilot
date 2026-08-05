import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { AppError } from "./errors.js";
import type { Project } from "./project-service.js";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;

interface ProjectCursor {
  type: "projects";
  offset: number;
}

interface SessionCursor {
  type: "sessions";
  modifiedAt: number;
  id: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

function encodeCursor(cursor: ProjectCursor | SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) {
    throw new AppError(400, "invalid_cursor", "Invalid pagination cursor");
  }
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_cursor", "Invalid pagination cursor");
  }
}

export function pageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) {
    throw new AppError(400, "invalid_page_size", "Page size must be an integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new AppError(
      400,
      "invalid_page_size",
      `Page size must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  return parsed;
}

export function projectPage(
  projects: readonly Project[],
  cursorValue: unknown,
  limit: number,
): Page<Project> {
  let offset = 0;
  if (cursorValue !== undefined) {
    if (typeof cursorValue !== "string") {
      throw new AppError(400, "invalid_cursor", "Invalid pagination cursor");
    }
    const cursor = decodeCursor(cursorValue);
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !("type" in cursor) ||
      cursor.type !== "projects" ||
      !("offset" in cursor) ||
      typeof cursor.offset !== "number" ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      throw new AppError(400, "invalid_cursor", "Invalid project pagination cursor");
    }
    offset = cursor.offset;
  }

  const items = projects.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < projects.length
      ? { nextCursor: encodeCursor({ type: "projects", offset: nextOffset }) }
      : {}),
  };
}

function isAfterSessionCursor(session: SessionInfo, cursor: SessionCursor): boolean {
  const modifiedAt = session.modified.getTime();
  return (
    modifiedAt < cursor.modifiedAt || (modifiedAt === cursor.modifiedAt && session.id > cursor.id)
  );
}

export function sessionPage<T extends SessionInfo>(
  sessions: readonly T[],
  cursorValue: unknown,
  limit: number,
): Page<T> {
  let start = 0;
  if (cursorValue !== undefined) {
    if (typeof cursorValue !== "string") {
      throw new AppError(400, "invalid_cursor", "Invalid pagination cursor");
    }
    const decoded = decodeCursor(cursorValue);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("type" in decoded) ||
      decoded.type !== "sessions" ||
      !("modifiedAt" in decoded) ||
      typeof decoded.modifiedAt !== "number" ||
      !Number.isFinite(decoded.modifiedAt) ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0 ||
      decoded.id.length > 128
    ) {
      throw new AppError(400, "invalid_cursor", "Invalid session pagination cursor");
    }
    const cursor: SessionCursor = {
      type: "sessions",
      modifiedAt: decoded.modifiedAt,
      id: decoded.id,
    };
    start = sessions.findIndex((session) => isAfterSessionCursor(session, cursor));
    if (start < 0) start = sessions.length;
  }

  const items = sessions.slice(start, start + limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < sessions.length
      ? {
          nextCursor: encodeCursor({
            type: "sessions",
            modifiedAt: last.modified.getTime(),
            id: last.id,
          }),
        }
      : {}),
  };
}
