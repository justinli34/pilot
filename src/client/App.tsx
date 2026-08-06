import { useCallback, type CSSProperties } from "react";

import { MainView } from "./components/MainView.js";
import { ProjectBrowserDialog } from "./components/ProjectBrowserDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { useSidebarLayout } from "./use-sidebar-layout.js";
import { useSidebarSwipe } from "./use-sidebar-swipe.js";
import { useWorkspaceController } from "./use-workspace-controller.js";

export function App() {
  const layout = useSidebarLayout();
  const { toggle } = layout;
  const workspace = useWorkspaceController({ closeMobileNavigation: layout.closeMobile });
  const toggleNavigation = useCallback(() => toggle(), [toggle]);
  const sidebarSwipe = useSidebarSwipe({
    enabled: layout.mobileViewport,
    open: layout.mobileSidebarOpen,
    onOpen: toggleNavigation,
    onClose: layout.closeMobile,
  });

  return (
    <div
      className={`app-shell${layout.effectiveCollapsed ? " sidebar-is-collapsed" : ""}${layout.mobileSidebarOpen ? " mobile-sidebar-open" : ""}`}
      style={{ "--sidebar-width": `${layout.width}px` } as CSSProperties}
      onPointerDown={sidebarSwipe.onPointerDown}
      onPointerMove={sidebarSwipe.onPointerMove}
      onPointerUp={sidebarSwipe.onPointerUp}
      onPointerCancel={sidebarSwipe.onPointerCancel}
    >
      <a
        className="skip-link"
        href="#main-content"
        aria-hidden={layout.mobileSidebarOpen || undefined}
        tabIndex={layout.mobileSidebarOpen ? -1 : undefined}
      >
        Skip to content
      </a>
      <Sidebar
        projects={workspace.projects}
        sessions={workspace.sessions}
        selectedSessionId={workspace.selectedSessionId}
        projectsLoading={workspace.projectsLoading}
        sessionsLoading={workspace.sessionsLoading}
        creatingProjectId={workspace.creatingProjectId}
        archivingProjectId={workspace.archivingProjectId}
        mutatingSessionId={workspace.mutatingSessionId}
        collapsed={layout.contentCollapsed}
        width={layout.width}
        minWidth={layout.widthMetrics.min}
        maxWidth={layout.widthMetrics.max}
        resizeStep={layout.widthMetrics.step}
        onToggleCollapsed={layout.toggle}
        onResize={layout.resize}
        onResizeEnd={layout.commitWidth}
        onAddProject={workspace.openProjectBrowser}
        onRemoveProject={workspace.removeProject}
        onArchiveProjectSessions={workspace.archiveProjectSessions}
        onSelectSession={workspace.selectSession}
        onCreate={(projectId) => void workspace.create(projectId)}
        onRenameSession={workspace.renameSession}
        onSetSessionArchived={workspace.setSessionArchived}
        onDeleteSession={workspace.deleteSession}
      />
      <button
        className="mobile-sidebar-backdrop"
        type="button"
        aria-label="Close navigation"
        aria-hidden={!layout.mobileSidebarOpen}
        tabIndex={layout.mobileSidebarOpen ? 0 : -1}
        onClick={layout.closeMobile}
      />
      <div className="mobile-sidebar-swipe-edge" data-sidebar-swipe-edge aria-hidden="true" />
      <div
        className="session-view-stack"
        aria-hidden={layout.mobileSidebarOpen || undefined}
        inert={layout.mobileSidebarOpen || undefined}
      >
        <MainView
          key={workspace.activeViewKey ?? "empty"}
          project={workspace.selectedProject}
          session={workspace.selectedSession}
          snapshot={workspace.snapshot}
          connection={workspace.connection}
          notification={workspace.notification}
          error={workspace.error}
          workspaceError={workspace.workspaceError}
          showSessionHeader={layout.mobileViewport || layout.sidebarCollapsed}
          creatingSession={workspace.creatingProjectId === workspace.selectedProject?.id}
          onOpenNavigation={toggleNavigation}
          onAddProject={workspace.openProjectBrowser}
          onCreateSession={(projectId) => void workspace.create(projectId)}
          onRestoreSession={(projectId, sessionId) =>
            workspace.setSessionArchived(projectId, sessionId, false)
          }
          onDismissError={workspace.dismissError}
          sendCommand={workspace.sendCommand}
        />
      </div>
      {workspace.projectBrowserOpen && (
        <ProjectBrowserDialog
          adding={workspace.addingProject}
          error={workspace.browserError}
          onClose={workspace.closeProjectBrowser}
          onAdd={workspace.addProjectPath}
        />
      )}
    </div>
  );
}
