import { useCallback, useEffect, useMemo, useState } from "react";

import type { ProjectSummary } from "../shared/protocol.js";
import {
  addProject,
  createSession,
  deleteSession as deleteSessionRequest,
  getProjects,
  markSessionRead as markSessionReadRequest,
  removeProject as removeProjectRequest,
  renameSession as renameSessionRequest,
  setSessionArchived as setSessionArchivedRequest,
} from "./api.js";
import { forgetSessionSnapshot, useSessionSocket } from "./use-session-socket.js";
import { useWorkspaceSessions } from "./use-workspace-sessions.js";

const PROJECT_KEY = "pilot.selectedProject";
const sessionKey = (projectId: string) => `pilot.selectedSession.${projectId}`;
const viewKey = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected browser error";
}

function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return projects.sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

async function loadAllProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  let cursor: string | undefined;
  do {
    const response = await getProjects(cursor, signal);
    projects.push(...response.projects);
    cursor = response.nextCursor;
  } while (cursor);
  return sortProjects(projects);
}

interface WorkspaceControllerOptions {
  closeMobileNavigation: () => void;
}

export function useWorkspaceController({ closeMobileNavigation }: WorkspaceControllerOptions) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const {
    sessions,
    loading: sessionsLoading,
    error: workspaceError,
    upsertSession,
    removeSession: removeWorkspaceSession,
    removeProjectSessions,
  } = useWorkspaceSessions();
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [browserError, setBrowserError] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(
    () => localStorage.getItem(PROJECT_KEY) ?? undefined,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [creatingProjectId, setCreatingProjectId] = useState<string>();
  const [removingProjectId, setRemovingProjectId] = useState<string>();
  const [archivingProjectId, setArchivingProjectId] = useState<string>();
  const [mutatingSessionId, setMutatingSessionId] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void loadAllProjects(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setProjects(loaded);
        setSelectedProjectId((current) =>
          current && loaded.some((project) => project.id === current) ? current : loaded[0]?.id,
        );
        setActionError(undefined);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setActionError(`Could not load projects: ${message(error)}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectsLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedProjectId) localStorage.setItem(PROJECT_KEY, selectedProjectId);
    else localStorage.removeItem(PROJECT_KEY);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || sessionsLoading) return;
    if (
      selectedSessionId &&
      sessions.some(
        (session) => session.id === selectedSessionId && session.projectId === selectedProjectId,
      )
    ) {
      return;
    }
    const active = sessions.filter(
      (session) => session.projectId === selectedProjectId && !session.archived,
    );
    const stored = localStorage.getItem(sessionKey(selectedProjectId));
    const selected = active.find((session) => session.id === stored) ?? active[0];
    setSelectedSessionId(selected?.id);
  }, [selectedProjectId, selectedSessionId, sessions, sessionsLoading]);

  useEffect(() => {
    if (selectedProjectId && selectedSessionId) {
      localStorage.setItem(sessionKey(selectedProjectId), selectedSessionId);
    }
  }, [selectedProjectId, selectedSessionId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId],
  );
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const socket = useSessionSocket(selectedProjectId, selectedSessionId);
  const { snapshot } = socket;

  useEffect(() => {
    if (!selectedProjectId || !selectedSession?.unread) return;
    let active = true;
    void markSessionReadRequest(selectedProjectId, selectedSession.id)
      .then(({ session }) => {
        if (active) upsertSession(session);
      })
      .catch((error) => {
        if (active) setActionError(`Could not mark session read: ${message(error)}`);
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId, selectedSession?.id, selectedSession?.unread, upsertSession]);

  useEffect(() => {
    if (!selectedSession || !snapshot) return;
    if (
      selectedSession.status === snapshot.runtime.status &&
      selectedSession.phase === snapshot.runtime.phase &&
      (snapshot.identity.name === undefined || snapshot.identity.name === selectedSession.name)
    ) {
      return;
    }
    upsertSession({
      ...selectedSession,
      status: snapshot.runtime.status,
      phase: snapshot.runtime.phase,
      name: snapshot.identity.name ?? selectedSession.name,
    });
  }, [selectedSession, snapshot, upsertSession]);

  const selectSession = useCallback(
    (projectId: string, sessionId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(sessionId);
      closeMobileNavigation();
    },
    [closeMobileNavigation],
  );

  const openProjectBrowser = useCallback(() => {
    setBrowserError(undefined);
    closeMobileNavigation();
    setProjectBrowserOpen(true);
  }, [closeMobileNavigation]);

  const closeProjectBrowser = useCallback(() => {
    if (!addingProject) setProjectBrowserOpen(false);
  }, [addingProject]);

  const addProjectPath = useCallback(
    async (path: string) => {
      if (addingProject) return;
      setAddingProject(true);
      setBrowserError(undefined);
      try {
        const { project } = await addProject(path);
        setProjects((current) => sortProjects([...current, project]));
        setSelectedProjectId(project.id);
        setSelectedSessionId(undefined);
        setProjectBrowserOpen(false);
        closeMobileNavigation();
        setActionError(undefined);
      } catch (error) {
        setBrowserError(message(error));
        throw error;
      } finally {
        setAddingProject(false);
      }
    },
    [addingProject, closeMobileNavigation],
  );

  const removeProject = useCallback(
    async (project: ProjectSummary) => {
      if (removingProjectId || archivingProjectId) return;
      setRemovingProjectId(project.id);
      setActionError(undefined);
      try {
        await removeProjectRequest(project.id);
        const remaining = projects.filter((candidate) => candidate.id !== project.id);
        setProjects(remaining);
        removeProjectSessions(project.id);
        if (selectedProjectId === project.id) {
          const nextProject = remaining[0];
          setSelectedProjectId(nextProject?.id);
          const nextSession = nextProject
            ? sessions.find((session) => session.projectId === nextProject.id && !session.archived)
            : undefined;
          setSelectedSessionId(nextSession?.id);
        }
      } catch (error) {
        setActionError(`Could not remove project: ${message(error)}`);
        throw error;
      } finally {
        setRemovingProjectId(undefined);
      }
    },
    [
      archivingProjectId,
      projects,
      removingProjectId,
      selectedProjectId,
      sessions,
      removeProjectSessions,
    ],
  );

  const create = useCallback(
    async (projectId: string) => {
      if (creatingProjectId || archivingProjectId || mutatingSessionId) return;
      setCreatingProjectId(projectId);
      setActionError(undefined);
      try {
        const { session } = await createSession(projectId);
        upsertSession(session);
        setSelectedProjectId(projectId);
        setSelectedSessionId(session.id);
        closeMobileNavigation();
      } catch (error) {
        setActionError(`Could not create session: ${message(error)}`);
      } finally {
        setCreatingProjectId(undefined);
      }
    },
    [
      archivingProjectId,
      closeMobileNavigation,
      creatingProjectId,
      mutatingSessionId,
      upsertSession,
    ],
  );

  const renameSession = useCallback(
    async (projectId: string, sessionId: string, name: string) => {
      if (mutatingSessionId || archivingProjectId) return;
      setMutatingSessionId(sessionId);
      setActionError(undefined);
      try {
        const { session } = await renameSessionRequest(projectId, sessionId, name);
        upsertSession(session);
      } catch (error) {
        setActionError(`Could not rename session: ${message(error)}`);
        throw error;
      } finally {
        setMutatingSessionId(undefined);
      }
    },
    [archivingProjectId, mutatingSessionId, upsertSession],
  );

  const setSessionArchived = useCallback(
    async (projectId: string, sessionId: string, archived: boolean) => {
      if (mutatingSessionId || archivingProjectId) return;
      setMutatingSessionId(sessionId);
      setActionError(undefined);
      try {
        const { session } = await setSessionArchivedRequest(projectId, sessionId, archived);
        upsertSession(session);
        if (archived && selectedSessionId === sessionId) {
          const next = sessions.find(
            (candidate) =>
              candidate.projectId === projectId &&
              candidate.id !== sessionId &&
              !candidate.archived,
          );
          setSelectedSessionId(next?.id);
          if (!next) localStorage.removeItem(sessionKey(projectId));
        }
      } catch (error) {
        setActionError(
          `Could not ${archived ? "archive" : "unarchive"} session: ${message(error)}`,
        );
        throw error;
      } finally {
        setMutatingSessionId(undefined);
      }
    },
    [archivingProjectId, mutatingSessionId, selectedSessionId, sessions, upsertSession],
  );

  const archiveProjectSessions = useCallback(
    async (projectId: string) => {
      if (archivingProjectId || creatingProjectId || removingProjectId || mutatingSessionId) return;
      const targets = sessions.filter(
        (session) => session.projectId === projectId && !session.archived,
      );
      if (targets.length === 0) return;
      if (targets.some((session) => session.status === "running")) {
        const error = new Error("Stop running sessions first");
        setActionError(`Could not archive all sessions: ${error.message}`);
        throw error;
      }

      setArchivingProjectId(projectId);
      setActionError(undefined);
      try {
        const results = await Promise.allSettled(
          targets.map(async (target) => {
            const { session } = await setSessionArchivedRequest(projectId, target.id, true);
            upsertSession(session);
            return session;
          }),
        );
        const archivedIds = new Set(
          results.flatMap((result, index) =>
            result.status === "fulfilled" ? [targets[index]!.id] : [],
          ),
        );
        setSelectedSessionId((current) => {
          if (!current || !archivedIds.has(current)) return current;
          const next = sessions.find(
            (candidate) =>
              candidate.projectId === projectId &&
              !candidate.archived &&
              !archivedIds.has(candidate.id),
          );
          if (!next) localStorage.removeItem(sessionKey(projectId));
          return next?.id;
        });
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      } catch (error) {
        setActionError(`Could not archive all sessions: ${message(error)}`);
        throw error;
      } finally {
        setArchivingProjectId(undefined);
      }
    },
    [
      archivingProjectId,
      creatingProjectId,
      mutatingSessionId,
      removingProjectId,
      sessions,
      upsertSession,
    ],
  );

  const deleteSession = useCallback(
    async (projectId: string, sessionId: string) => {
      if (mutatingSessionId || archivingProjectId) return;
      setMutatingSessionId(sessionId);
      setActionError(undefined);
      try {
        await deleteSessionRequest(projectId, sessionId);
        removeWorkspaceSession(sessionId);
        forgetSessionSnapshot(projectId, sessionId);
        if (selectedSessionId === sessionId) {
          const next = sessions.find(
            (candidate) => candidate.projectId === projectId && candidate.id !== sessionId,
          );
          setSelectedSessionId(next?.id);
        }
      } finally {
        // The confirmation dialog owns request errors so they are only announced once.
        setMutatingSessionId(undefined);
      }
    },
    [archivingProjectId, mutatingSessionId, removeWorkspaceSession, selectedSessionId, sessions],
  );

  const dismissError = useCallback(() => setActionError(undefined), []);

  return {
    projects,
    projectsLoading,
    sessions,
    sessionsLoading,
    selectedProject,
    selectedSession,
    selectedSessionId,
    creatingProjectId,
    archivingProjectId,
    mutatingSessionId,
    error: actionError,
    workspaceError,
    projectBrowserOpen,
    addingProject,
    browserError,
    activeViewKey:
      selectedProject && selectedSession
        ? viewKey(selectedProject.id, selectedSession.id)
        : selectedProject?.id,
    ...socket,
    selectSession,
    openProjectBrowser,
    closeProjectBrowser,
    addProjectPath,
    removeProject,
    create,
    renameSession,
    setSessionArchived,
    archiveProjectSessions,
    deleteSession,
    dismissError,
  };
}
