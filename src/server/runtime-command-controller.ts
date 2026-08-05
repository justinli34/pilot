import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  type ClientCommand,
  type ImageAttachment,
  type JsonValue,
  type StreamingBehavior,
  type ThinkingLevel,
} from "../shared/protocol.js";
import { AppError, errorMessage } from "./errors.js";
import { validateImageAttachments } from "./images.js";
import type { NativeMessageQueue } from "./message-queue.js";
import type { RuntimeStateTracker } from "./runtime-state.js";
import { truncateUtf8 } from "./security.js";

interface RuntimeCommandControllerOptions {
  session: AgentSession;
  state: RuntimeStateTracker;
  messageQueue: NativeMessageQueue;
  isDisposed: () => boolean;
  isIdle: () => boolean;
  ensureAvailable: () => void;
  ensureIdle: (action: string) => void;
  emitRuntime: () => void;
  syncView: (isBusy: boolean) => void;
  touch: () => void;
  setError: (action: string, error: unknown) => void;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevel) => void;
  refresh: () => Promise<void>;
}

export class RuntimeCommandController {
  private compactionTask?: Promise<unknown>;

  constructor(private readonly options: RuntimeCommandControllerOptions) {}

  async execute(command: ClientCommand): Promise<JsonValue> {
    this.options.ensureAvailable();
    switch (command.type) {
      case "prompt":
        await this.startPrompt(command.text, command.streamingBehavior, command.images);
        return { accepted: true };
      case "abort":
        return this.abort();
      case "update_queued_message":
        await this.options.messageQueue.update(
          command.messageId,
          command.queueRevision,
          command.text,
          command.streamingBehavior,
        );
        return { updated: true };
      case "delete_queued_message":
        await this.options.messageQueue.delete(command.messageId, command.queueRevision);
        return { deleted: true };
      case "clear_queued_messages":
        await this.options.messageQueue.clear(command.queueRevision);
        return { cleared: true };
      case "set_model":
        await this.options.setModel(command.provider, command.modelId);
        return { changed: true };
      case "set_thinking_level":
        this.options.setThinkingLevel(command.level);
        return { changed: true };
      case "compact":
        this.startCompaction();
        return { accepted: true };
      case "refresh":
        await this.options.refresh();
        return { refreshed: true };
      case "ping":
        return { pong: Date.now() };
    }
  }

  private async startPrompt(
    text: string,
    streamingBehavior: StreamingBehavior = "steer",
    images: readonly ImageAttachment[] = [],
  ): Promise<void> {
    const { messageQueue, session, state } = this.options;
    validateImageAttachments(images);
    if (images.length > 0 && session.model && !session.model.input.includes("image")) {
      throw new AppError(
        400,
        "images_unsupported",
        "The selected model does not support image input",
      );
    }
    if (messageQueue.isMutating) {
      throw new AppError(409, "queue_busy", "A queued-message change is in progress");
    }
    if (state.has("abort")) {
      throw new AppError(
        409,
        "session_aborting",
        "Sending a prompt is unavailable while the session is stopping",
      );
    }
    const wasStreaming = session.isStreaming;
    if (!wasStreaming) this.options.ensureIdle("Sending a prompt");
    const releaseImageReservation = wasStreaming
      ? messageQueue.reserveImages(text, streamingBehavior, images)
      : () => {};

    const operation = state.begin("prompt-preflight");
    if (!wasStreaming) state.clearError();
    this.options.emitRuntime();

    let resolvePreflight: (accepted: boolean) => void = () => {};
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    const completion = session.prompt(text, {
      source: "rpc",
      streamingBehavior,
      ...(images.length > 0 ? { images: [...images] } : {}),
      preflightResult: resolvePreflight,
    });
    void completion.then(
      () => {
        state.end(operation);
        if (this.options.isDisposed()) return;
        this.options.touch();
        if (session.isIdle) this.options.syncView(false);
        this.options.emitRuntime();
      },
      (error) => {
        state.end(operation);
        if (this.options.isDisposed()) return;
        this.options.setError("Send prompt", error);
      },
    );

    const accepted = await preflight.finally(releaseImageReservation);
    state.end(operation);
    this.options.emitRuntime();
    if (accepted) return;
    try {
      await completion;
      throw new AppError(400, "prompt_rejected", "Pi rejected the prompt before starting");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, "prompt_failed", truncateUtf8(errorMessage(error), 4_096));
    }
  }

  private async abort(): Promise<JsonValue> {
    const { session, state } = this.options;
    if (this.options.isIdle()) return { accepted: false, reason: "already_idle" };
    if (state.has("abort")) return { accepted: false, reason: "already_aborting" };
    const operation = state.begin("abort");
    this.options.emitRuntime();
    try {
      const clearedQueue = session.clearQueue();
      const clearedQueueDepth = clearedQueue.steering.length + clearedQueue.followUp.length;
      session.abortCompaction();
      await session.abort();
      await this.compactionTask?.catch(() => undefined);
      state.endRetry();
      this.options.syncView(false);
      return { accepted: true, clearedQueueDepth };
    } catch (error) {
      this.options.setError("Stop run", error);
      throw new AppError(
        500,
        "abort_failed",
        `Stop run failed: ${truncateUtf8(errorMessage(error), 2_048)}`,
      );
    } finally {
      state.end(operation);
      this.options.emitRuntime();
    }
  }

  private startCompaction(): void {
    const { session, state } = this.options;
    this.options.ensureIdle("Compacting context");
    const operation = state.begin("compact");
    state.clearError();
    this.options.emitRuntime();
    const completion = session.compact();
    this.compactionTask = completion;
    void completion.then(
      () => {
        state.end(operation);
        this.compactionTask = undefined;
        if (this.options.isDisposed()) return;
        this.options.touch();
        this.options.syncView(false);
        this.options.emitRuntime();
      },
      (error) => {
        state.end(operation);
        this.compactionTask = undefined;
        if (this.options.isDisposed()) return;
        if (!state.has("abort")) this.options.setError("Compact context", error);
      },
    );
  }
}
