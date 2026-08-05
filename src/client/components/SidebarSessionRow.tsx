import {
  Archive,
  ArchiveRestore,
  Check,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import {
  MAX_SESSION_NAME_LENGTH,
  type ProjectSummary,
  type SessionSummary,
} from "../../shared/protocol.js";
import { focusFirstMenuItem, handleMenuKeyDown, shouldCloseMenuOnBlur } from "../menu-keyboard.js";

interface SidebarSessionRowProps {
  session: SessionSummary;
  project?: ProjectSummary;
  showProject: boolean;
  selected: boolean;
  unread: boolean;
  mutatingSessionId?: string;
  archivingProjectId?: string;
  onSelect: (projectId: string, sessionId: string) => void;
  onRename: (projectId: string, sessionId: string, name: string) => Promise<void>;
  onSetArchived: (projectId: string, sessionId: string, archived: boolean) => Promise<void>;
  onRequestDelete: (session: SessionSummary) => void;
}

function sessionTitle(session: SessionSummary): string {
  return session.name || session.firstMessage || "New session";
}

function sessionStateLabel(session: SessionSummary): string {
  if (session.phase === "retrying") return "Retrying";
  if (session.phase === "compacting") return "Compacting context";
  if (session.phase === "aborting") return "Stopping";
  if (session.status === "running") return "Running";
  if (session.status === "error") return "Error";
  return "Idle";
}

export const SidebarSessionRow = memo(function SidebarSessionRow({
  session,
  project,
  showProject,
  selected,
  unread,
  mutatingSessionId,
  archivingProjectId,
  onSelect,
  onRename,
  onSetArchived,
  onRequestDelete,
}: SidebarSessionRowProps) {
  const [rename, setRename] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useRef<HTMLSpanElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const stateLabel = sessionStateLabel(session);
  const showErrorIndicator = session.status === "error";
  const showUnreadIndicator = unread && !selected && !showErrorIndicator;
  const showRunningIndicator = session.status === "running";
  const showTrailingIndicators = showRunningIndicator || showUnreadIndicator;
  const hasMeta =
    (showProject && project !== undefined) || session.archived || session.status === "error";

  useEffect(() => {
    if (!menuOpen) return;
    const focusFrame = window.requestAnimationFrame(() => focusFirstMenuItem(actions));
    const closeMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && actions.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeMenu);
    };
  }, [menuOpen]);

  const submitRename = async () => {
    const name = rename?.trim();
    if (!name || mutatingSessionId || archivingProjectId) return;
    try {
      await onRename(session.projectId, session.id, name);
      setRename(undefined);
    } catch {
      // The workspace controller displays the request error in the shared toast.
    }
  };

  const setArchived = async () => {
    if (mutatingSessionId || archivingProjectId || session.status === "running") return;
    setMenuOpen(false);
    try {
      await onSetArchived(session.projectId, session.id, !session.archived);
    } catch {
      // The workspace controller displays the request error in the shared toast.
    }
  };

  return (
    <div
      className={`session-row${hasMeta ? " has-meta" : ""}${session.archived ? " archived" : ""}${selected ? " selected" : ""}${rename !== undefined ? " renaming" : ""}${menuOpen ? " menu-open" : ""}`}
    >
      {rename !== undefined ? (
        <form
          className={`session-rename-form${showErrorIndicator ? " has-status-dot" : ""}${showTrailingIndicators ? " has-trailing-indicators" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          {showErrorIndicator && (
            <span
              className="status-dot status-error"
              role="img"
              aria-label={stateLabel}
              title={stateLabel}
            />
          )}
          <input
            name="sessionName"
            value={rename}
            maxLength={MAX_SESSION_NAME_LENGTH}
            aria-label="Session name"
            placeholder={sessionTitle(session)}
            autoComplete="off"
            autoFocus
            disabled={mutatingSessionId !== undefined || archivingProjectId !== undefined}
            onChange={(event) => setRename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRename(undefined);
            }}
          />
          <button
            type="submit"
            aria-label="Save session name"
            aria-busy={mutatingSessionId === session.id}
            disabled={
              mutatingSessionId !== undefined || archivingProjectId !== undefined || !rename.trim()
            }
          >
            {mutatingSessionId === session.id ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
          </button>
          <button type="button" aria-label="Cancel rename" onClick={() => setRename(undefined)}>
            <X size={14} />
          </button>
          {showTrailingIndicators && (
            <span className="session-trailing-indicators">
              {showRunningIndicator && (
                <LoaderCircle
                  className="session-running-indicator spin"
                  size={13}
                  aria-label={stateLabel}
                />
              )}
              {showUnreadIndicator && (
                <span
                  className="status-dot status-unread"
                  role="img"
                  aria-label="Unread"
                  title="Unread"
                />
              )}
            </span>
          )}
        </form>
      ) : (
        <>
          <button
            className="session-row-select"
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => onSelect(session.projectId, session.id)}
          >
            {showErrorIndicator && (
              <span
                className="status-dot status-error"
                role="img"
                aria-label={stateLabel}
                title={stateLabel}
              />
            )}
            <span className="session-copy">
              <span className="session-title" title={sessionTitle(session)}>
                {sessionTitle(session)}
              </span>
              {hasMeta && (
                <span className="session-meta">
                  {showProject && project && (
                    <span className="session-project-name">{project.name}</span>
                  )}
                  {session.archived && (
                    <span className="session-archive-state">
                      {showProject && project ? "· Archived" : "Archived"}
                    </span>
                  )}
                  {session.status === "error" && (
                    <span className="session-error-state">
                      {(showProject && project !== undefined) || session.archived
                        ? "· Error"
                        : "Error"}
                    </span>
                  )}
                </span>
              )}
            </span>
            {showTrailingIndicators && (
              <span className="session-trailing-indicators">
                {showRunningIndicator && (
                  <LoaderCircle
                    className="session-running-indicator spin"
                    size={13}
                    aria-label={stateLabel}
                  />
                )}
                {showUnreadIndicator && (
                  <span
                    className="status-dot status-unread"
                    role="img"
                    aria-label="Unread"
                    title="Unread"
                  />
                )}
              </span>
            )}
          </button>
          <span
            className="session-actions"
            data-actions-menu=""
            ref={actions}
            onBlur={(event) => {
              if (shouldCloseMenuOnBlur(event.currentTarget, event.relatedTarget)) {
                setMenuOpen(false);
              }
            }}
            onKeyDown={(event) => {
              if (menuOpen) {
                handleMenuKeyDown(event, actions, menuButton, () => setMenuOpen(false));
              }
            }}
          >
            <button
              type="button"
              aria-label={`${session.archived ? "Unarchive" : "Archive"} ${sessionTitle(session)}`}
              title={
                session.status === "running"
                  ? "Stop the session first"
                  : session.archived
                    ? "Unarchive session"
                    : "Archive session"
              }
              disabled={
                mutatingSessionId !== undefined ||
                archivingProjectId !== undefined ||
                session.status === "running"
              }
              onClick={() => void setArchived()}
            >
              {mutatingSessionId === session.id ? (
                <LoaderCircle className="spin" size={14} />
              ) : session.archived ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}
            </button>
            <button
              ref={menuButton}
              type="button"
              aria-label={`Actions for ${sessionTitle(session)}`}
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
                className="actions-menu session-menu"
                role="menu"
                aria-label={`${sessionTitle(session)} actions`}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setRename(session.name ?? "");
                  }}
                >
                  <Pencil size={13} /> Rename
                </button>
                <button
                  className="danger"
                  type="button"
                  role="menuitem"
                  disabled={session.status === "running"}
                  title={session.status === "running" ? "Stop the session first" : undefined}
                  onClick={() => {
                    setMenuOpen(false);
                    onRequestDelete(session);
                  }}
                >
                  <Trash2 size={13} /> Delete
                </button>
              </span>
            )}
          </span>
        </>
      )}
    </div>
  );
});
