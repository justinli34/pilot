import {
  AlertTriangle,
  ArchiveRestore,
  CloudOff,
  FolderOpen,
  LoaderCircle,
  PanelLeftOpen,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import type {
  ClientCommand,
  ImageAttachment,
  JsonValue,
  ProjectSummary,
  ServerEvent,
  SessionSnapshot,
  SessionSummary,
  StreamingBehavior,
} from "../../shared/protocol.js";
import { CommandError, type ConnectionState } from "../use-session-socket.js";
import { Composer } from "./Composer.js";
import { TranscriptView } from "./TranscriptView.js";

interface MainViewProps {
  project?: ProjectSummary;
  session?: SessionSummary;
  snapshot?: SessionSnapshot;
  connection: ConnectionState;
  notification?: Extract<ServerEvent, { type: "notification" }>;
  error?: string;
  workspaceError?: string;
  showSessionHeader: boolean;
  creatingSession: boolean;
  onOpenNavigation: () => void;
  onAddProject: () => void;
  onCreateSession: (projectId: string) => void;
  onRestoreSession: (projectId: string, sessionId: string) => Promise<void>;
  onDismissError: () => void;
  sendCommand: (command: ClientCommand) => Promise<JsonValue | undefined>;
}

function runtimeLabel(snapshot: SessionSnapshot | undefined, session: SessionSummary): string {
  if (snapshot?.runtime.phase === "retrying") return "Retrying";
  if (snapshot?.runtime.phase === "compacting") return "Compacting context";
  if (snapshot?.runtime.phase === "aborting") return "Stopping";
  const status = snapshot?.runtime.status ?? session.status;
  if (status === "running") return "Running";
  if (status === "error") return "Error";
  return "Idle";
}

function title(session: SessionSummary | undefined, snapshot: SessionSnapshot | undefined): string {
  return snapshot?.identity.name || session?.name || session?.firstMessage || "New session";
}

interface ToastRegionProps {
  connection?: ConnectionState;
  connectionError?: string;
  error?: string;
  notice?: Extract<ServerEvent, { type: "notification" }>;
  onDismissError: () => void;
  onDismissNotice: () => void;
}

export function ToastRegion({
  connection,
  connectionError,
  error,
  notice,
  onDismissError,
  onDismissNotice,
}: ToastRegionProps) {
  const connectionProblem = connection === "reconnecting" || connection === "disconnected";
  const connectionNotice = connectionProblem && notice?.tone === "error" ? notice : undefined;
  const visibleNotice = connectionNotice || notice?.message === error ? undefined : notice;
  const showConnection = connectionProblem || connectionError !== undefined;
  if (!showConnection && !error && !visibleNotice) return null;

  return (
    <div className="toast-region" aria-live="polite" aria-relevant="additions text">
      {showConnection && (
        <div className="app-toast connection-toast" role="status">
          {connection === "disconnected" ? (
            <CloudOff size={15} />
          ) : (
            <LoaderCircle className="spin" size={16} />
          )}
          <div>
            <strong>
              {connection === "reconnecting"
                ? "Reconnecting"
                : connection === "disconnected"
                  ? "Session unavailable"
                  : "Session updates unavailable"}
            </strong>
            <span>
              {connectionNotice?.message ??
                (connection === "reconnecting"
                  ? "Restoring the latest session state…"
                  : connection === "disconnected"
                    ? "Select another session or reload to retry."
                    : connectionError)}
            </span>
          </div>
        </div>
      )}
      {error && (
        <div className="app-toast toast-error" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>Action failed</strong>
            <span>{error}</span>
          </div>
          <button type="button" aria-label="Dismiss error" onClick={onDismissError}>
            <X size={14} />
          </button>
        </div>
      )}
      {visibleNotice && (
        <div className={`app-toast toast-${visibleNotice.tone}`} role="status">
          {visibleNotice.tone !== "info" && <AlertTriangle size={15} />}
          <span className="toast-message">{visibleNotice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={onDismissNotice}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export const MainView = memo(function MainView({
  project,
  session,
  snapshot,
  connection,
  notification,
  error,
  workspaceError,
  showSessionHeader,
  creatingSession,
  onOpenNavigation,
  onAddProject,
  onCreateSession,
  onRestoreSession,
  onDismissError,
  sendCommand,
}: MainViewProps) {
  const [commandError, setCommandError] = useState<string>();
  const [notice, setNotice] = useState<typeof notification>();
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (notification) setNotice(notification);
  }, [notification]);

  useEffect(() => {
    if (connection !== "connecting") return;
    setCommandError(undefined);
    setNotice(undefined);
  }, [connection]);

  const runCommand = useCallback(
    async (command: ClientCommand) => {
      setCommandError(undefined);
      onDismissError();
      try {
        return await sendCommand(command);
      } catch (error) {
        const separatelyPresented =
          error instanceof CommandError &&
          ["abort_failed", "connection_lost", "not_connected", "prompt_failed"].includes(
            error.code,
          );
        if (!separatelyPresented) {
          setCommandError(error instanceof Error ? error.message : "Command failed");
        }
        throw error;
      }
    },
    [onDismissError, sendCommand],
  );

  const selectModel = useCallback(
    async (provider: string, modelId: string) => {
      await runCommand({ type: "set_model", provider, modelId });
    },
    [runCommand],
  );
  const selectThinkingLevel = useCallback(
    (level: SessionSnapshot["thinkingLevel"]) => {
      void runCommand({ type: "set_thinking_level", level }).catch(() => undefined);
    },
    [runCommand],
  );
  const sendPrompt = useCallback(
    async (text: string, images: ImageAttachment[], streamingBehavior: StreamingBehavior) => {
      await runCommand({
        type: "prompt",
        text,
        ...(images.length > 0 ? { images } : {}),
        streamingBehavior,
      });
    },
    [runCommand],
  );
  const updateQueuedMessage = useCallback(
    async (
      messageId: string,
      queueRevision: number,
      text: string,
      streamingBehavior: StreamingBehavior,
    ) => {
      await runCommand({
        type: "update_queued_message",
        messageId,
        queueRevision,
        text,
        streamingBehavior,
      });
    },
    [runCommand],
  );
  const deleteQueuedMessage = useCallback(
    async (messageId: string, queueRevision: number) => {
      await runCommand({ type: "delete_queued_message", messageId, queueRevision });
    },
    [runCommand],
  );
  const clearQueuedMessages = useCallback(
    async (queueRevision: number) => {
      await runCommand({ type: "clear_queued_messages", queueRevision });
    },
    [runCommand],
  );
  const stopRun = useCallback(async () => {
    await runCommand({ type: "abort" });
  }, [runCommand]);
  const restoreSession = useCallback(async () => {
    if (!session || restoring) return;
    setCommandError(undefined);
    setRestoring(true);
    try {
      await onRestoreSession(session.projectId, session.id);
    } catch {
      // The workspace controller presents this request error in the shared toast.
    } finally {
      setRestoring(false);
    }
  }, [onRestoreSession, restoring, session]);

  const stateLabel = session ? runtimeLabel(snapshot, session) : undefined;
  const stateStatus = session ? (snapshot?.runtime.status ?? session.status) : undefined;
  const heading = session ? title(session, snapshot) : (project?.name ?? "Pilot");

  useEffect(() => {
    document.title = heading === "Pilot" ? "Pilot" : `${heading} · Pilot`;
  }, [heading]);

  const sessionHeader = showSessionHeader ? (
    <header className="compact-session-header">
      <button
        className="sidebar-toggle"
        type="button"
        aria-label="Open navigation"
        aria-controls="pilot-navigation"
        title="Open navigation"
        onClick={onOpenNavigation}
      >
        <PanelLeftOpen aria-hidden="true" size={19} />
      </button>
      {stateStatus === "error" && (
        <span
          className="compact-session-status status-error"
          role="img"
          aria-label={stateLabel}
          title={stateLabel}
        >
          <AlertTriangle aria-hidden="true" size={14} />
        </span>
      )}
      <h1 title={heading}>{heading}</h1>
    </header>
  ) : null;
  const toasts = (
    <ToastRegion
      connection={session ? connection : undefined}
      connectionError={workspaceError}
      error={commandError ?? error}
      notice={notification ? notice : undefined}
      onDismissError={() => {
        setCommandError(undefined);
        onDismissError();
      }}
      onDismissNotice={() => setNotice(undefined)}
    />
  );

  if (!project) {
    return (
      <main id="main-content" className="main-view" tabIndex={-1}>
        {sessionHeader}
        {toasts}
        <div className="main-placeholder">
          <FolderOpen aria-hidden="true" size={30} />
          <h1>No project selected</h1>
          <p>Add a folder from the server to begin.</p>
          <button className="main-placeholder-action" type="button" onClick={onAddProject}>
            <Plus aria-hidden="true" size={15} /> Add project
          </button>
        </div>
      </main>
    );
  }
  if (!session) {
    return (
      <main id="main-content" className="main-view" tabIndex={-1}>
        {sessionHeader}
        {toasts}
        <div className="main-placeholder">
          <Sparkles aria-hidden="true" size={30} />
          <h1>Start a Pi session</h1>
          <p>Create a persistent workspace for your next task.</p>
          <button
            className="main-placeholder-action"
            type="button"
            disabled={creatingSession}
            aria-busy={creatingSession}
            onClick={() => onCreateSession(project.id)}
          >
            {creatingSession ? (
              <LoaderCircle className="spin" aria-hidden="true" size={16} />
            ) : (
              <Plus aria-hidden="true" size={15} />
            )}
            {creatingSession ? "Creating session…" : "New session"}
          </button>
        </div>
      </main>
    );
  }

  const connected = connection === "connected";

  return (
    <main id="main-content" className="main-view" tabIndex={-1}>
      {sessionHeader}
      {toasts}

      {!snapshot ? (
        <div className="session-loading" aria-live="polite">
          Opening session…
        </div>
      ) : (
        <>
          <TranscriptView
            transcript={snapshot.transcript}
            streamingMessage={snapshot.streamingMessage}
            tools={snapshot.tools}
            runtime={snapshot.runtime}
          />
          {session.archived ? (
            <div className="archived-session-wrap">
              <div className="archived-session-card">
                <ArchiveRestore aria-hidden="true" size={18} />
                <div>
                  <strong>Archived session</strong>
                  <span>Restore this session to continue the conversation.</span>
                </div>
                <button
                  type="button"
                  disabled={restoring}
                  aria-busy={restoring}
                  onClick={() => void restoreSession()}
                >
                  {restoring && <LoaderCircle className="spin" aria-hidden="true" size={14} />}
                  Restore
                </button>
              </div>
            </div>
          ) : (
            <Composer
              sessionId={session.id}
              busy={snapshot.runtime.isBusy}
              queueable={
                snapshot.runtime.phase === "running" || snapshot.runtime.phase === "retrying"
              }
              queue={snapshot.queue}
              connected={connected}
              models={snapshot.models}
              currentModel={snapshot.currentModel}
              thinkingLevel={snapshot.thinkingLevel}
              thinkingLevels={snapshot.thinkingLevels}
              contextUsage={snapshot.contextUsage}
              commands={snapshot.commands}
              onSelectModel={selectModel}
              onSelectThinkingLevel={selectThinkingLevel}
              onSend={sendPrompt}
              onUpdateQueuedMessage={updateQueuedMessage}
              onDeleteQueuedMessage={deleteQueuedMessage}
              onClearQueuedMessages={clearQueuedMessages}
              onStop={stopRun}
            />
          )}
        </>
      )}
    </main>
  );
});
