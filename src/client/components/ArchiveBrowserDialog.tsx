import { Folder, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ProjectSummary, SessionSummary } from "../../shared/protocol.js";
import { ModalDialog } from "./ModalDialog.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";

interface ArchiveBrowserDialogProps {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  selectedSessionId?: string;
  mutatingSessionId?: string;
  archivingProjectId?: string;
  onClose: () => void;
  onSelect: (projectId: string, sessionId: string) => void;
  onRename: (projectId: string, sessionId: string, name: string) => Promise<void>;
  onSetArchived: (projectId: string, sessionId: string, archived: boolean) => Promise<void>;
  onRequestDelete: (session: SessionSummary) => void;
}

export interface ArchivedSessionGroup {
  project: ProjectSummary;
  sessions: SessionSummary[];
}

export function groupArchivedSessions(
  projects: ProjectSummary[],
  sessions: SessionSummary[],
  searchQuery: string,
): ArchivedSessionGroup[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const query = searchQuery.trim().toLocaleLowerCase();
  const matching = sessions.filter((session) => {
    if (!session.archived) return false;
    if (!query) return true;
    const project = projectsById.get(session.projectId);
    return [session.name, session.firstMessage, project?.name, project?.path].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    );
  });
  const sessionsByProject = new Map<string, SessionSummary[]>();
  for (const session of matching) {
    const group = sessionsByProject.get(session.projectId);
    if (group) group.push(session);
    else sessionsByProject.set(session.projectId, [session]);
  }

  return projects.flatMap((project) => {
    const projectSessions = sessionsByProject.get(project.id);
    return projectSessions ? [{ project, sessions: projectSessions }] : [];
  });
}

export function ArchiveBrowserDialog({
  projects,
  sessions,
  selectedSessionId,
  mutatingSessionId,
  archivingProjectId,
  onClose,
  onSelect,
  onRename,
  onSetArchived,
  onRequestDelete,
}: ArchiveBrowserDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const archivedGroups = useMemo(
    () => groupArchivedSessions(projects, sessions, ""),
    [projects, sessions],
  );
  const matchingGroups = useMemo(
    () => groupArchivedSessions(projects, sessions, searchQuery),
    [projects, searchQuery, sessions],
  );
  const selectedProject = archivedGroups.find(
    (group) => group.project.id === selectedProjectId,
  )?.project;
  const matchingSessions = selectedProjectId
    ? (matchingGroups.find((group) => group.project.id === selectedProjectId)?.sessions ?? [])
    : matchingGroups.flatMap((group) => group.sessions);
  const archivedSessionCount = archivedGroups.reduce(
    (count, group) => count + group.sessions.length,
    0,
  );
  const hasSearch = searchQuery.trim().length > 0;

  useEffect(() => {
    if (
      selectedProjectId &&
      !archivedGroups.some((group) => group.project.id === selectedProjectId)
    ) {
      setSelectedProjectId(undefined);
    }
  }, [archivedGroups, selectedProjectId]);

  return (
    <ModalDialog
      backdropClassName="archive-browser-backdrop"
      dialogClassName="archive-browser-dialog"
      labelledBy="archive-browser-title"
      onClose={onClose}
    >
      <header className="archive-browser-header">
        <h2 id="archive-browser-title">Archived sessions</h2>
        <button type="button" aria-label="Close archived sessions" title="Close" onClick={onClose}>
          <X size="var(--size-icon-lucide-md)" />
        </button>
      </header>

      <div className="archive-browser-body">
        <aside className="archive-browser-projects" aria-label="Archived session projects">
          <div className="archive-browser-projects-heading">Projects</div>
          <button
            className={!selectedProjectId ? "selected" : undefined}
            type="button"
            aria-pressed={!selectedProjectId}
            onClick={() => setSelectedProjectId(undefined)}
          >
            <span>All projects</span>
            <small>{archivedSessionCount}</small>
          </button>
          {archivedGroups.map(({ project, sessions: projectSessions }) => (
            <button
              className={selectedProjectId === project.id ? "selected" : undefined}
              type="button"
              aria-pressed={selectedProjectId === project.id}
              title={project.path}
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
            >
              <Folder aria-hidden="true" size="var(--size-icon-lucide-sm)" />
              <span>{project.name}</span>
              <small>{projectSessions.length}</small>
            </button>
          ))}
        </aside>

        <section className="archive-browser-main">
          <div className="archive-browser-filter">
            <Search aria-hidden="true" size="var(--size-icon-lucide-sm)" />
            <input
              value={searchQuery}
              type="search"
              name="archivedSessionSearch"
              placeholder="Search archived sessions…"
              aria-label="Search archived sessions"
              autoComplete="off"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchQuery) {
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchQuery("");
                }
              }}
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear archived session search"
                title="Clear search"
                onClick={() => setSearchQuery("")}
              >
                <X aria-hidden="true" size="var(--size-icon-lucide-xs)" />
              </button>
            )}
          </div>

          <div
            className="archive-browser-sessions"
            aria-label={
              selectedProject ? `${selectedProject.name} archived sessions` : "Archived sessions"
            }
          >
            {matchingSessions.length === 0 ? (
              <div className="archive-browser-state">
                {hasSearch
                  ? `No archived sessions match “${searchQuery.trim()}”`
                  : "No archived sessions"}
              </div>
            ) : (
              <div className="archive-project-sessions">
                {matchingSessions.map((session) => (
                  <SidebarSessionRow
                    key={session.id}
                    session={session}
                    showProject={false}
                    showArchiveState={false}
                    showCreatedAt
                    selected={session.id === selectedSessionId}
                    unread={session.unread}
                    mutatingSessionId={mutatingSessionId}
                    archivingProjectId={archivingProjectId}
                    onSelect={(projectId, sessionId) => {
                      onSelect(projectId, sessionId);
                      onClose();
                    }}
                    onRename={onRename}
                    onSetArchived={onSetArchived}
                    onRequestDelete={onRequestDelete}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}
