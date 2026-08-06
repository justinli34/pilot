import { Check, Image as ImageIcon, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { memo, useDeferredValue, useEffect, useState, type KeyboardEvent } from "react";

import {
  MAX_PROMPT_BYTES,
  type MessageQueueState,
  type QueuedMessage,
  type StreamingBehavior,
} from "../../shared/protocol.js";

interface QueuedMessagesProps {
  queue: MessageQueueState;
  connected: boolean;
  onUpdate: (
    messageId: string,
    queueRevision: number,
    text: string,
    streamingBehavior: StreamingBehavior,
  ) => Promise<void>;
  onDelete: (messageId: string, queueRevision: number) => Promise<void>;
  onClear: (queueRevision: number) => Promise<void>;
}

interface QueuedMessageEdit {
  id: string;
  text: string;
  streamingBehavior: StreamingBehavior;
  imageCount: number;
}

function behaviorLabel(behavior: StreamingBehavior): string {
  return behavior === "steer" ? "Steering" : "Follow-up";
}

const textEncoder = new TextEncoder();

export const QueuedMessages = memo(function QueuedMessages({
  queue,
  connected,
  onUpdate,
  onDelete,
  onClear,
}: QueuedMessagesProps) {
  const [editing, setEditing] = useState<QueuedMessageEdit>();
  const [pendingAction, setPendingAction] = useState<string>();
  const deferredEditText = useDeferredValue(editing?.text ?? "");
  const editBytes = textEncoder.encode(deferredEditText).byteLength;
  const editInvalid =
    !editing ||
    (editing.text.trim().length === 0 && editing.imageCount === 0) ||
    editBytes > MAX_PROMPT_BYTES;

  useEffect(() => {
    if (editing && !queue.messages.some((message) => message.id === editing.id)) {
      setEditing(undefined);
    }
  }, [editing, queue.messages]);

  if (queue.messages.length === 0) return null;

  const beginEdit = (message: QueuedMessage) => {
    if (pendingAction) return;
    setEditing({
      id: message.id,
      text: message.text,
      streamingBehavior: message.streamingBehavior,
      imageCount: message.imageCount,
    });
  };

  const saveEdit = async () => {
    if (
      !editing ||
      (editing.text.trim().length === 0 && editing.imageCount === 0) ||
      textEncoder.encode(editing.text).byteLength > MAX_PROMPT_BYTES ||
      pendingAction ||
      !connected
    )
      return;
    setPendingAction(editing.id);
    try {
      await onUpdate(editing.id, queue.revision, editing.text, editing.streamingBehavior);
      setEditing(undefined);
    } catch {
      // MainView keeps the command error visible and the edit open for retry.
    } finally {
      setPendingAction(undefined);
    }
  };

  const deleteMessage = async (messageId: string) => {
    if (pendingAction || !connected) return;
    setPendingAction(messageId);
    try {
      await onDelete(messageId, queue.revision);
      if (editing?.id === messageId) setEditing(undefined);
    } catch {
      // MainView keeps the command error visible.
    } finally {
      setPendingAction(undefined);
    }
  };

  const clearQueue = async () => {
    if (pendingAction || !connected) return;
    setPendingAction("clear");
    try {
      await onClear(queue.revision);
      setEditing(undefined);
    } catch {
      // MainView keeps the command error visible.
    } finally {
      setPendingAction(undefined);
    }
  };

  const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(undefined);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveEdit();
    }
  };

  return (
    <section className="message-queue" aria-label="Queued messages">
      <div className="message-queue-header">
        <span>
          Queued <strong>{queue.messages.length}</strong>
        </span>
        <button
          type="button"
          aria-busy={pendingAction === "clear"}
          disabled={!connected || pendingAction !== undefined}
          onClick={() => void clearQueue()}
        >
          {pendingAction === "clear" && <LoaderCircle className="spin" size={11} />}
          Clear all
        </button>
      </div>
      <div className="message-queue-list">
        {queue.messages.map((message) => {
          const isEditing = editing?.id === message.id;
          const pending = pendingAction === message.id;
          return (
            <div className="queued-message" key={message.id}>
              {isEditing && editing ? (
                <div className="queued-message-editor">
                  <div className="queued-message-editor-meta">
                    <label>
                      <select
                        aria-label="Queued message delivery"
                        value={editing.streamingBehavior}
                        disabled={pending}
                        onChange={(event) =>
                          setEditing((current) =>
                            current
                              ? {
                                  ...current,
                                  streamingBehavior: event.target.value as StreamingBehavior,
                                }
                              : current,
                          )
                        }
                      >
                        <option value="steer">Steering</option>
                        <option value="followUp">Follow-up</option>
                      </select>
                    </label>
                    {editing.imageCount > 0 && (
                      <span className="queued-image-count">
                        <ImageIcon size={11} /> {editing.imageCount}
                      </span>
                    )}
                    <span className={editBytes > MAX_PROMPT_BYTES ? "over" : ""}>
                      {Math.ceil(editBytes / 1024)} / {MAX_PROMPT_BYTES / 1024} KiB
                    </span>
                  </div>
                  <textarea
                    name="queuedMessage"
                    aria-label="Edit queued message"
                    value={editing.text}
                    rows={3}
                    readOnly={pending}
                    onChange={(event) =>
                      setEditing((current) =>
                        current ? { ...current, text: event.target.value } : current,
                      )
                    }
                    onKeyDown={onEditKeyDown}
                  />
                  <div className="queued-message-editor-actions">
                    <span>Ctrl+Enter to save · Esc to cancel</span>
                    <button
                      className="queued-icon-button queued-delete-button"
                      type="button"
                      aria-label="Delete queued message"
                      title="Delete queued message"
                      disabled={pending}
                      onClick={() => void deleteMessage(message.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className="queued-icon-button"
                      type="button"
                      aria-label="Cancel editing"
                      title="Cancel"
                      disabled={pending}
                      onClick={() => setEditing(undefined)}
                    >
                      <X size={14} />
                    </button>
                    <button
                      className="queued-save-button"
                      type="button"
                      aria-busy={pending}
                      disabled={editInvalid || pending || !connected}
                      onClick={() => void saveEdit()}
                    >
                      {pending ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span
                    className={`queued-message-kind queued-message-kind-${message.streamingBehavior === "steer" ? "steer" : "follow-up"}`}
                  >
                    {behaviorLabel(message.streamingBehavior)}
                  </span>
                  <button
                    className="queued-message-text"
                    type="button"
                    title="Edit queued message"
                    disabled={pendingAction !== undefined}
                    onClick={() => beginEdit(message)}
                  >
                    <span>
                      {message.text ||
                        `${message.imageCount} image${message.imageCount === 1 ? "" : "s"}`}
                    </span>
                    {message.imageCount > 0 && (
                      <small className="queued-image-count">
                        <ImageIcon size={11} /> {message.imageCount} image
                        {message.imageCount === 1 ? "" : "s"}
                      </small>
                    )}
                    {message.truncated && <small>Preview truncated</small>}
                  </button>
                  <button
                    className="queued-icon-button"
                    type="button"
                    aria-label="Edit queued message"
                    title="Edit queued message"
                    disabled={!connected || pendingAction !== undefined}
                    onClick={() => beginEdit(message)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="queued-icon-button queued-delete-button"
                    type="button"
                    aria-label="Delete queued message"
                    title="Delete queued message"
                    disabled={!connected || pendingAction !== undefined}
                    onClick={() => void deleteMessage(message.id)}
                  >
                    {pending ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
});
