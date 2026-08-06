import {
  Archive,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  SquarePen,
  X,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { ProjectSummary, SessionSummary } from "../../shared/protocol.js";
import { handleMenuKeyDown, shouldCloseMenuOnBlur } from "../menu-keyboard.js";
import { SidebarSessionRow } from "./SidebarSessionRow.js";

interface SidebarProjectSectionProps {
  project: ProjectSummary;
  sessions: SessionSummary[];
  collapsed: boolean;
  sessionsLoading: boolean;
  selectedSessionId?: string;
  creatingProjectId?: string;
  archivingProjectId?: string;
  mutatingSessionId?: string;
  onToggle: (projectId: string) => void;
  onCreate: (projectId: string) => void;
  onRemove: (project: ProjectSummary) => Promise<void>;
  onArchiveAll: (projectId: string) => Promise<void>;
  onSelect: (projectId: string, sessionId: string) => void;
  onRename: (projectId: string, sessionId: string, name: string) => Promise<void>;
  onSetArchived: (projectId: string, sessionId: string, archived: boolean) => Promise<void>;
  onRequestDelete: (session: SessionSummary) => void;
}

export const SidebarProjectSection = memo(function SidebarProjectSection({
  project,
  sessions,
  collapsed,
  sessionsLoading,
  selectedSessionId,
  creatingProjectId,
  archivingProjectId,
  mutatingSessionId,
  onToggle,
  onCreate,
  onRemove,
  onArchiveAll,
  onSelect,
  onRename,
  onSetArchived,
  onRequestDelete,
}: SidebarProjectSectionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useRef<HTMLSpanElement>(null);
  const creating = creatingProjectId === project.id;
  const archiving = archivingProjectId === project.id;
  const hasRunningSession = sessions.some((session) => session.status === "running");
  const archiveAllTitle =
    sessions.length === 0
      ? "No active sessions to archive"
      : hasRunningSession
        ? "Stop running sessions first"
        : `Archive all sessions in ${project.name}`;

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && actions.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [menuOpen]);

  const archiveAll = async () => {
    if (mutatingSessionId || archivingProjectId) return;
    try {
      await onArchiveAll(project.id);
      setMenuOpen(false);
    } catch {
      // The workspace controller displays the request error in the shared toast.
    }
  };

  return (
    <section className="project-section">
      <div className={`project-row${menuOpen ? " menu-open" : ""}`}>
        <button
          className="project-select"
          type="button"
          title={project.path}
          aria-label={`${collapsed ? "Open" : "Close"} ${project.name}`}
          aria-expanded={!collapsed}
          onClick={() => onToggle(project.id)}
        >
          {collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
          <span>{project.name}</span>
        </button>
        <span
          className="project-actions"
          data-actions-menu=""
          ref={actions}
          onBlur={(event) => {
            if (shouldCloseMenuOnBlur(event.currentTarget, event.relatedTarget)) {
              setMenuOpen(false);
            }
          }}
          onKeyDown={(event) => {
            if (menuOpen) {
              handleMenuKeyDown(event, actions, () => setMenuOpen(false));
            }
          }}
        >
          <button
            type="button"
            title="New session"
            aria-label={`New session in ${project.name}`}
            aria-busy={creating}
            disabled={
              creating || mutatingSessionId !== undefined || archivingProjectId !== undefined
            }
            onClick={() => onCreate(project.id)}
          >
            {creating ? <LoaderCircle className="spin" size={14} /> : <SquarePen size={14} />}
          </button>
          <button
            type="button"
            title="Project actions"
            aria-label={`Actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (!menuOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <span
              className="actions-menu project-menu"
              role="menu"
              aria-label={`${project.name} actions`}
            >
              <button
                type="button"
                role="menuitem"
                title={archiving ? "Archiving all sessions…" : archiveAllTitle}
                disabled={
                  sessions.length === 0 ||
                  hasRunningSession ||
                  creatingProjectId !== undefined ||
                  mutatingSessionId !== undefined ||
                  archivingProjectId !== undefined
                }
                onClick={() => void archiveAll()}
              >
                {archiving ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={14} />
                ) : (
                  <Archive aria-hidden="true" size={13} />
                )}{" "}
                Archive all
              </button>
              <button
                className="danger"
                type="button"
                role="menuitem"
                disabled={mutatingSessionId !== undefined || archivingProjectId !== undefined}
                onClick={() => {
                  setMenuOpen(false);
                  void onRemove(project).catch(() => undefined);
                }}
              >
                <X size={13} /> Remove from Pilot
              </button>
            </span>
          )}
        </span>
      </div>
      {!collapsed && (
        <div className="project-sessions" aria-label={`${project.name} sessions`}>
          {sessionsLoading && sessions.length === 0 ? (
            <div className="project-sessions-empty">Loading sessions…</div>
          ) : sessions.length === 0 ? (
            <div className="project-sessions-empty">No sessions</div>
          ) : (
            sessions.map((session) => (
              <SidebarSessionRow
                key={session.id}
                session={session}
                project={project}
                showProject={false}
                selected={session.id === selectedSessionId}
                unread={session.unread}
                mutatingSessionId={mutatingSessionId}
                archivingProjectId={archivingProjectId}
                onSelect={onSelect}
                onRename={onRename}
                onSetArchived={onSetArchived}
                onRequestDelete={onRequestDelete}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
});
