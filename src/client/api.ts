import type { z } from "zod/mini";

import {
  ApiErrorResponseSchema,
  CreateSessionResponseSchema,
  DeleteProjectResponseSchema,
  DeleteSessionResponseSchema,
  DirectoryListingSchema,
  ProjectResponseSchema,
  ProjectsResponseSchema,
  UpdateSessionResponseSchema,
  type CreateSessionResponse,
  type DeleteProjectResponse,
  type DeleteSessionResponse,
  type DirectoryListing,
  type ProjectResponse,
  type ProjectsResponse,
  type UpdateSessionResponse,
} from "../shared/protocol.js";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, schema: z.ZodMiniType<T>, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ApiErrorResponseSchema.safeParse(body);
    throw new ApiError(
      error.success ? error.data.error.code : "request_failed",
      error.success ? error.data.error.message : response.statusText || "Request failed",
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      "invalid_response",
      "The server returned a response that does not match the Pilot protocol",
      response.status,
    );
  }
  return parsed.data;
}

function paginatedPath(path: string, cursor?: string): string {
  if (!cursor) return path;
  const query = new URLSearchParams({ cursor });
  return `${path}?${query}`;
}

export function getProjects(cursor?: string, signal?: AbortSignal): Promise<ProjectsResponse> {
  return request(paginatedPath("/api/v1/projects", cursor), ProjectsResponseSchema, { signal });
}

export function addProject(path: string): Promise<ProjectResponse> {
  return request("/api/v1/projects", ProjectResponseSchema, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function removeProject(projectId: string): Promise<DeleteProjectResponse> {
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}`, DeleteProjectResponseSchema, {
    method: "DELETE",
  });
}

export function browseDirectories(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
  return request(`/api/v1/filesystem/directories${query}`, DirectoryListingSchema, { signal });
}

export function createSession(projectId: string): Promise<CreateSessionResponse> {
  return request(
    `/api/v1/projects/${encodeURIComponent(projectId)}/sessions`,
    CreateSessionResponseSchema,
    { method: "POST", body: "{}" },
  );
}

function sessionPath(projectId: string, sessionId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function renameSession(
  projectId: string,
  sessionId: string,
  name: string,
): Promise<UpdateSessionResponse> {
  return request(sessionPath(projectId, sessionId), UpdateSessionResponseSchema, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function setSessionArchived(
  projectId: string,
  sessionId: string,
  archived: boolean,
): Promise<UpdateSessionResponse> {
  return request(sessionPath(projectId, sessionId), UpdateSessionResponseSchema, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
}

export function markSessionRead(
  projectId: string,
  sessionId: string,
): Promise<UpdateSessionResponse> {
  return request(sessionPath(projectId, sessionId), UpdateSessionResponseSchema, {
    method: "PATCH",
    body: JSON.stringify({ unread: false }),
  });
}

export function deleteSession(
  projectId: string,
  sessionId: string,
): Promise<DeleteSessionResponse> {
  return request(sessionPath(projectId, sessionId), DeleteSessionResponseSchema, {
    method: "DELETE",
  });
}
