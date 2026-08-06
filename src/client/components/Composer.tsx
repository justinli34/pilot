import {
  ChevronDown,
  FileCode,
  LoaderCircle,
  Paperclip,
  SendHorizontal,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import {
  MAX_PROMPT_BYTES,
  type ContextUsage,
  type ImageAttachment,
  type MessageQueueState,
  type SafeModel,
  type SessionSnapshot,
  type SlashCommandSummary,
  type StreamingBehavior,
  type ThinkingLevel,
} from "../../shared/protocol.js";
import {
  appendTextAttachments,
  formatFileBytes,
  isPendingImage,
  pendingImageSource,
} from "../attachment-upload.js";
import { useAttachments } from "../use-attachments.js";
import { usePersistedDraft, utf8Bytes } from "../use-persisted-draft.js";
import { useSlashCommands } from "../use-slash-commands.js";
import { QueuedMessages } from "./QueuedMessages.js";

interface ComposerProps {
  sessionId: string;
  busy: boolean;
  queueable: boolean;
  queue: MessageQueueState;
  connected: boolean;
  models: SafeModel[];
  currentModel: SessionSnapshot["currentModel"];
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  contextUsage: ContextUsage | null;
  commands: SlashCommandSummary[];
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  onSend: (
    text: string,
    images: ImageAttachment[],
    streamingBehavior: StreamingBehavior,
  ) => Promise<void>;
  onUpdateQueuedMessage: (
    messageId: string,
    queueRevision: number,
    text: string,
    streamingBehavior: StreamingBehavior,
  ) => Promise<void>;
  onDeleteQueuedMessage: (messageId: string, queueRevision: number) => Promise<void>;
  onClearQueuedMessages: (queueRevision: number) => Promise<void>;
  onStop: () => Promise<void>;
}

function modelLabel(model: SafeModel): string {
  return model.provider === "openai-codex" ? model.name : `${model.provider} / ${model.name}`;
}

function thinkingLevelLabel(level: ThinkingLevel): string {
  if (level === "xhigh") return "Extra high";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function contextTitle(contextUsage: ContextUsage | null): string {
  if (!contextUsage) return "Context usage is unavailable";
  if (contextUsage.tokens === null || contextUsage.percent === null) {
    return `Context usage is recalculating · ${contextUsage.contextWindow.toLocaleString()} token window`;
  }
  return `Context: ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens (${contextUsage.percent.toFixed(1)}%)`;
}

export const Composer = memo(function Composer({
  sessionId,
  busy,
  queueable,
  queue,
  connected,
  models,
  currentModel,
  thinkingLevel,
  thinkingLevels,
  contextUsage,
  commands,
  onSelectModel,
  onSelectThinkingLevel,
  onSend,
  onUpdateQueuedMessage,
  onDeleteQueuedMessage,
  onClearQueuedMessages,
  onStop,
}: ComposerProps) {
  const { draft, setDraft, clearDraft } = usePersistedDraft(sessionId);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingModel, setPendingModel] = useState<{ provider: string; id: string }>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canSubmit = connected && (!busy || queueable);
  const currentModelIndex = useMemo(
    () =>
      currentModel
        ? models.findIndex(
            (model) => model.provider === currentModel.provider && model.id === currentModel.id,
          )
        : -1,
    [currentModel, models],
  );
  const pendingModelIndex = useMemo(
    () =>
      pendingModel
        ? models.findIndex(
            (model) => model.provider === pendingModel.provider && model.id === pendingModel.id,
          )
        : -1,
    [models, pendingModel],
  );
  const modelOptions = useMemo(
    () =>
      models.map((model, index) => (
        <option value={index} key={`${model.provider}/${model.id}`}>
          {modelLabel(model)}
        </option>
      )),
    [models],
  );
  const selectedModelIndex = pendingModelIndex >= 0 ? pendingModelIndex : currentModelIndex;
  const selectedModel = models[selectedModelIndex];
  const supportsImages = selectedModel?.supportsImages === true;
  const {
    attachments,
    images,
    textFiles,
    error: attachmentError,
    reading: readingAttachments,
    dragging: draggingAttachments,
    setDragging: setDraggingAttachments,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useAttachments(supportsImages);
  const prompt = appendTextAttachments(draft, textFiles);
  const promptBytes = utf8Bytes(prompt);
  const tooLarge = prompt.length > MAX_PROMPT_BYTES || promptBytes > MAX_PROMPT_BYTES;
  const imagesUnsupported = images.length > 0 && !supportsImages;
  const hasContent = prompt.trim().length > 0 || images.length > 0;
  const selectedModelLabel = selectedModel
    ? modelLabel(selectedModel)
    : models.length === 0
      ? "No authenticated models"
      : "Select a model";
  const {
    matches: matchingCommands,
    selectedIndex: commandIndex,
    choose: selectCommand,
    reset: resetCommands,
    handleKeyDown: handleCommandKeyDown,
  } = useSlashCommands({
    draft,
    commands,
    select: (command) => setDraft(`/${command.name} `),
  });
  const knownContextPercent = contextUsage?.percent;
  const contextPercent = knownContextPercent ?? 0;
  const contextRingPercent = Math.min(100, Math.max(0, contextPercent));
  const contextTone =
    knownContextPercent === null || knownContextPercent === undefined
      ? " context-unknown"
      : knownContextPercent > 90
        ? " context-critical"
        : knownContextPercent > 70
          ? " context-warning"
          : "";

  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "0px";
    textarea.current.style.height = `${textarea.current.scrollHeight}px`;
  }, [draft]);

  const pastedFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) void addFiles(files);
  };

  const droppedFiles = (event: DragEvent<HTMLDivElement>) => {
    setDraggingAttachments(false);
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  };

  const submit = async (streamingBehavior: StreamingBehavior = "steer") => {
    const exactBytes = utf8Bytes(prompt);
    if (
      !canSubmit ||
      sending ||
      readingAttachments ||
      imagesUnsupported ||
      prompt.length > MAX_PROMPT_BYTES ||
      exactBytes > MAX_PROMPT_BYTES ||
      !hasContent
    )
      return;
    setSending(true);
    try {
      await onSend(
        prompt,
        images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
        streamingBehavior,
      );
      clearDraft();
      clearAttachments();
    } catch {
      // MainView keeps the command error visible; retain the draft for retry.
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!busy || stopping) return;
    setStopping(true);
    try {
      await onStop();
    } catch {
      // MainView displays the failure and the runtime remains connected for retry.
    } finally {
      setStopping(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || handleCommandKeyDown(event)) return;
    const submitShortcut = event.key === "Enter" && !event.shiftKey;
    if (!submitShortcut) return;
    event.preventDefault();
    void submit(event.altKey ? "followUp" : "steer");
  };

  return (
    <div className="composer-wrap">
      <div
        className={`composer${busy ? " composer-busy" : ""}${draggingAttachments ? " composer-dragging" : ""}`}
        onDragEnter={(event) => {
          if (![...event.dataTransfer.types].includes("Files")) return;
          event.preventDefault();
          setDraggingAttachments(true);
        }}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
            setDraggingAttachments(false);
          }
        }}
        onDrop={droppedFiles}
      >
        <input
          ref={fileInput}
          type="file"
          name="fileAttachments"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            if (files.length > 0) void addFiles(files);
          }}
        />
        <QueuedMessages
          queue={queue}
          connected={connected}
          onUpdate={onUpdateQueuedMessage}
          onDelete={onDeleteQueuedMessage}
          onClear={onClearQueuedMessages}
        />
        {matchingCommands.length > 0 && (
          <div className="slash-command-menu" id="slash-command-menu" role="listbox">
            <div className="slash-command-heading">
              <Sparkles size={12} /> Commands
            </div>
            {matchingCommands.map((command, index) => (
              <button
                className={`slash-command-option${index === commandIndex ? " selected" : ""}`}
                id={`slash-command-${index}`}
                role="option"
                aria-selected={index === commandIndex}
                type="button"
                key={`${command.source}:${command.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectCommand(command)}
              >
                <span>/{command.name}</span>
                <small>{command.description ?? `${command.source} command`}</small>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.id}>
                {isPendingImage(attachment) ? (
                  <img src={pendingImageSource(attachment)} alt="" />
                ) : (
                  <div className="composer-attachment-file-icon" aria-hidden="true">
                    <FileCode size={18} />
                  </div>
                )}
                <span>
                  <strong title={attachment.name}>{attachment.name}</strong>
                  <small>{formatFileBytes(attachment.bytes)}</small>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove file"
                  disabled={sending}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {(attachmentError || imagesUnsupported) && (
          <div className="composer-attachment-error" role="alert">
            {imagesUnsupported
              ? "The selected model does not support the attached images. Choose a vision model or remove them."
              : attachmentError}
          </div>
        )}
        <textarea
          ref={textarea}
          name="prompt"
          value={draft}
          rows={1}
          aria-label="Prompt"
          aria-autocomplete="list"
          aria-controls={matchingCommands.length > 0 ? "slash-command-menu" : undefined}
          aria-expanded={matchingCommands.length > 0}
          aria-activedescendant={
            matchingCommands.length > 0 ? `slash-command-${commandIndex}` : undefined
          }
          placeholder={
            busy
              ? queueable
                ? "Enter to steer · Alt+Enter for a follow-up…"
                : "Input is temporarily unavailable…"
              : attachments.length > 0
                ? "Add a message about these files…"
                : "Ask Pi to work on this project…"
          }
          disabled={!canSubmit}
          readOnly={sending}
          aria-busy={sending}
          onChange={(event) => {
            setDraft(event.target.value);
            resetCommands();
          }}
          onKeyDown={onKeyDown}
          onPaste={pastedFiles}
        />
        <div className="composer-footer">
          <button
            className="composer-attach-button"
            type="button"
            aria-label="Attach files"
            aria-busy={readingAttachments}
            title="Attach images, text, or code files"
            disabled={!canSubmit || sending || readingAttachments}
            onClick={() => fileInput.current?.click()}
          >
            {readingAttachments ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Paperclip size={15} />
            )}
          </button>
          {tooLarge && (
            <span className="composer-limit over" aria-live="polite">
              {Math.ceil(promptBytes / 1024)} KiB / {MAX_PROMPT_BYTES / 1024} KiB
            </span>
          )}
          <div className="composer-controls">
            <div
              className={`context-usage${contextTone}`}
              role="progressbar"
              tabIndex={0}
              aria-label="Context usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                knownContextPercent === null || knownContextPercent === undefined
                  ? undefined
                  : contextRingPercent
              }
              aria-valuetext={contextTitle(contextUsage)}
            >
              <svg className="context-ring" viewBox="0 0 20 20" aria-hidden="true">
                <circle
                  className="context-ring-background"
                  cx="10"
                  cy="10"
                  r="7.5"
                  pathLength="100"
                />
                {knownContextPercent !== null && knownContextPercent !== undefined && (
                  <circle
                    className="context-ring-value"
                    cx="10"
                    cy="10"
                    r="7.5"
                    pathLength="100"
                    strokeDasharray={`${contextRingPercent} ${100 - contextRingPercent}`}
                    transform="rotate(-90 10 10)"
                  />
                )}
              </svg>
              <span className="context-usage-tooltip" aria-hidden="true">
                {contextTitle(contextUsage)}
              </span>
            </div>
            <label
              className={`composer-select${pendingModel ? " composer-select-pending" : ""}`}
              title="Model"
            >
              <span className="composer-select-sizer" aria-hidden="true">
                {selectedModelLabel}
              </span>
              <select
                aria-label="Model"
                aria-busy={pendingModel !== undefined}
                value={selectedModelIndex}
                disabled={!connected || busy || models.length === 0}
                onChange={(event) => {
                  const model = models[Number(event.target.value)];
                  if (!model || pendingModel) return;
                  setPendingModel({ provider: model.provider, id: model.id });
                  void onSelectModel(model.provider, model.id)
                    .catch(() => undefined)
                    .finally(() => {
                      setPendingModel((pending) =>
                        pending?.provider === model.provider && pending.id === model.id
                          ? undefined
                          : pending,
                      );
                    });
                }}
              >
                {models.length === 0 && <option value={-1}>No authenticated models</option>}
                {models.length > 0 && currentModelIndex < 0 && (
                  <option value={-1} disabled>
                    Select a model
                  </option>
                )}
                {modelOptions}
              </select>
              <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
            </label>
            <label className="composer-select" title="Thinking effort">
              <span className="composer-select-sizer" aria-hidden="true">
                {thinkingLevelLabel(thinkingLevel)}
              </span>
              <select
                aria-label="Thinking effort"
                value={thinkingLevel}
                disabled={!connected || busy || thinkingLevels.length <= 1}
                onChange={(event) => {
                  const level = thinkingLevels.find(
                    (candidate) => candidate === event.target.value,
                  );
                  if (level) onSelectThinkingLevel(level);
                }}
              >
                {thinkingLevels.map((level) => (
                  <option value={level} key={level}>
                    {thinkingLevelLabel(level)}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
            </label>
          </div>
          {!busy && (
            <button
              className="send-button"
              type="button"
              aria-label="Send prompt"
              aria-busy={sending}
              disabled={
                !canSubmit ||
                sending ||
                readingAttachments ||
                imagesUnsupported ||
                tooLarge ||
                !hasContent
              }
              onClick={() => void submit("steer")}
            >
              {sending ? <LoaderCircle className="spin" size={16} /> : <SendHorizontal size={16} />}
            </button>
          )}
          {busy && (
            <button
              className="stop-button"
              type="button"
              aria-label="Stop the run and cancel queued messages"
              aria-busy={stopping}
              title="Stop the run and cancel queued messages"
              disabled={stopping || !connected}
              onClick={() => void stop()}
            >
              {stopping ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Square size={13} fill="currentColor" />
              )}
            </button>
          )}
        </div>
        {draggingAttachments && (
          <div className="composer-drop-overlay" aria-hidden="true">
            <Paperclip size={18} /> Drop files to attach
          </div>
        )}
      </div>
    </div>
  );
});
