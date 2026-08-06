import { Archive, FolderPlus, LoaderCircle, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { ProjectSummary, SessionSummary } from "../../shared/protocol.js";
import { useSidebarResize } from "../use-sidebar-resize.js";
import { ArchiveBrowserDialog } from "./ArchiveBrowserDialog.js";
import { ModalDialog } from "./ModalDialog.js";
import { SidebarProjectSection } from "./SidebarProjectSection.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";

const COLLAPSED_PROJECTS_KEY = "pilot.collapsedProjects";

interface SidebarProps {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  selectedSessionId?: string;
  projectsLoading: boolean;
  sessionsLoading: boolean;
  creatingProjectId?: string;
  archivingProjectId?: string;
  mutatingSessionId?: string;
  collapsed: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  resizeStep: number;
  onToggleCollapsed: () => void;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onAddProject: () => void;
  onRemoveProject: (project: ProjectSummary) => Promise<void>;
  onArchiveProjectSessions: (projectId: string) => Promise<void>;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onCreate: (projectId: string) => void;
  onRenameSession: (projectId: string, sessionId: string, name: string) => Promise<void>;
  onSetSessionArchived: (projectId: string, sessionId: string, archived: boolean) => Promise<void>;
  onDeleteSession: (projectId: string, sessionId: string) => Promise<void>;
}

function initialCollapsedProjects(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : [],
    );
  } catch {
    return new Set();
  }
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      backdropClassName="confirm-backdrop"
      dialogClassName="confirm-dialog"
      role="alertdialog"
      labelledBy="confirm-dialog-title"
      describedBy="confirm-dialog-description"
      closeDisabled={busy}
      initialFocus={cancelButton}
      onClose={onCancel}
    >
      <h2 id="confirm-dialog-title">{title}</h2>
      <p id="confirm-dialog-description">{description}</p>
      {error && (
        <div className="confirm-dialog-error" role="alert">
          {error}
        </div>
      )}
      <div className="confirm-dialog-actions">
        <button ref={cancelButton} type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="confirm-danger"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onConfirm}
        >
          {busy && <LoaderCircle className="spin" aria-hidden="true" size={14} />}
          {confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const [collapsedProjects, setCollapsedProjects] = useState(initialCollapsedProjects);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<SessionSummary>();
  const [dialogError, setDialogError] = useState<string>();
  const { beginResize, resizeWithKeyboard } = useSidebarResize({
    width: props.width,
    resizeStep: props.resizeStep,
    onResize: props.onResize,
    onResizeEnd: props.onResizeEnd,
    onToggleCollapsed: props.onToggleCollapsed,
  });

  const activeSessions = props.sessions.filter((session) => !session.archived);
  const archivedSessions = props.sessions.filter((session) => session.archived);
  const projectsById = new Map(props.projects.map((project) => [project.id, project]));
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchResults = normalizedSearch
    ? activeSessions.filter((session) => {
        const project = projectsById.get(session.projectId);
        return [session.name, session.firstMessage, project?.name, project?.path].some((value) =>
          value?.toLocaleLowerCase().includes(normalizedSearch),
        );
      })
    : [];

  useEffect(() => {
    setDeleteCandidate((current) =>
      current && props.sessions.some((session) => session.id === current.id) ? current : undefined,
    );
  }, [props.sessions]);

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const confirmDelete = async () => {
    if (!deleteCandidate || props.mutatingSessionId || props.archivingProjectId) return;
    setDialogError(undefined);
    try {
      await props.onDeleteSession(deleteCandidate.projectId, deleteCandidate.id);
      setDeleteCandidate(undefined);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "Could not delete the session.");
    }
  };

  const requestDelete = (candidate: SessionSummary) => {
    setDialogError(undefined);
    setDeleteCandidate(candidate);
  };

  const renderSession = (session: SessionSummary, showProject: boolean) => (
    <SidebarSessionRow
      key={session.id}
      session={session}
      project={projectsById.get(session.projectId)}
      showProject={showProject}
      selected={session.id === props.selectedSessionId}
      unread={session.unread}
      mutatingSessionId={props.mutatingSessionId}
      archivingProjectId={props.archivingProjectId}
      onSelect={props.onSelectSession}
      onRename={props.onRenameSession}
      onSetArchived={props.onSetSessionArchived}
      onRequestDelete={requestDelete}
    />
  );

  if (props.collapsed) return null;

  return (
    <aside id="pilot-navigation" className="sidebar" aria-label="Pilot navigation">
      <div className="projects-heading">
        <span>Projects</span>
        <button
          type="button"
          title="Add project"
          aria-label="Add project"
          onClick={props.onAddProject}
        >
          <Plus aria-hidden="true" size={15} />
        </button>
        <button
          type="button"
          title="Hide navigation"
          aria-label="Hide navigation"
          onClick={props.onToggleCollapsed}
        >
          <PanelLeftClose aria-hidden="true" size={16} />
        </button>
      </div>

      {(activeSessions.length > 0 || searchQuery.length > 0) && (
        <div className="sidebar-search">
          <Search aria-hidden="true" size={14} />
          <input
            type="search"
            value={searchQuery}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            autoComplete="off"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !searchQuery) return;
              event.preventDefault();
              setSearchQuery("");
            }}
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear session search"
              title="Clear search"
              onClick={() => setSearchQuery("")}
            >
              <X aria-hidden="true" size={13} />
            </button>
          )}
        </div>
      )}

      <div
        className="project-tree"
        aria-label={normalizedSearch ? "Session search results" : undefined}
      >
        {normalizedSearch && (
          <>
            <div className="sidebar-search-summary" aria-live="polite">
              {searchResults.length} {searchResults.length === 1 ? "session" : "sessions"}
            </div>
            {searchResults.length === 0 ? (
              <div className="sidebar-search-empty">No sessions match “{searchQuery.trim()}”</div>
            ) : (
              <nav className="sidebar-search-results" aria-label="Matching sessions">
                {searchResults.map((session) => renderSession(session, true))}
              </nav>
            )}
          </>
        )}
        {!normalizedSearch && (
          <>
            {props.projectsLoading && props.projects.length === 0 && (
              <div className="sidebar-empty">
                <LoaderCircle className="spin" size={16} /> Loading projects…
              </div>
            )}
            {!props.projectsLoading && props.projects.length === 0 && (
              <div className="sidebar-empty empty-projects">
                <FolderPlus size={24} />
                <strong>No projects added</strong>
                <span>Add any folder on this server to begin.</span>
                <button type="button" onClick={props.onAddProject}>
                  Browse folders
                </button>
              </div>
            )}
            {props.projects.map((project) => (
              <SidebarProjectSection
                key={project.id}
                project={project}
                sessions={activeSessions.filter((session) => session.projectId === project.id)}
                collapsed={collapsedProjects.has(project.id)}
                sessionsLoading={props.sessionsLoading}
                selectedSessionId={props.selectedSessionId}
                creatingProjectId={props.creatingProjectId}
                archivingProjectId={props.archivingProjectId}
                mutatingSessionId={props.mutatingSessionId}
                onToggle={toggleProject}
                onCreate={props.onCreate}
                onRemove={props.onRemoveProject}
                onArchiveAll={props.onArchiveProjectSessions}
                onSelect={props.onSelectSession}
                onRename={props.onRenameSession}
                onSetArchived={props.onSetSessionArchived}
                onRequestDelete={requestDelete}
              />
            ))}
          </>
        )}
      </div>

      {!normalizedSearch && (
        <section className="archive-section">
          <button
            className="archive-header"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setArchiveBrowserOpen(true)}
          >
            <Archive aria-hidden="true" size={14} /> <span>Archived</span>
          </button>
        </section>
      )}

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize or collapse sidebar"
        aria-orientation="vertical"
        title="Drag to resize or click to collapse"
        aria-valuemin={props.minWidth}
        aria-valuemax={props.maxWidth}
        aria-valuenow={props.width}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      />

      {archiveBrowserOpen && (
        <ArchiveBrowserDialog
          projects={props.projects}
          sessions={archivedSessions}
          selectedSessionId={props.selectedSessionId}
          mutatingSessionId={props.mutatingSessionId}
          archivingProjectId={props.archivingProjectId}
          onClose={() => setArchiveBrowserOpen(false)}
          onSelect={props.onSelectSession}
          onRename={props.onRenameSession}
          onSetArchived={props.onSetSessionArchived}
          onRequestDelete={requestDelete}
        />
      )}

      {deleteCandidate && (
        <ConfirmDialog
          title="Delete session?"
          description="This permanently removes the session transcript and cannot be undone."
          confirmLabel="Delete session"
          busy={
            props.mutatingSessionId === deleteCandidate.id || props.archivingProjectId !== undefined
          }
          error={dialogError}
          onCancel={() => {
            setDeleteCandidate(undefined);
            setDialogError(undefined);
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </aside>
  );
});
