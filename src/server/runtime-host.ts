import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";

import {
  type ClientCommand,
  type ContextUsage,
  type JsonValue,
  type RuntimeError,
  type RuntimePhase,
  type SafeModel,
  type SessionSnapshot,
  type SessionStatus,
  type SlashCommandSummary,
  type ThinkingLevel,
} from "../shared/protocol.js";
import { AppError, errorMessage } from "./errors.js";
import { LiveSessionProjector } from "./live-session-projector.js";
import { NativeMessageQueue } from "./message-queue.js";
import type { Project } from "./project-service.js";
import { RuntimeCommandController } from "./runtime-command-controller.js";
import { RuntimeStateTracker } from "./runtime-state.js";
import { safeLogMessage, truncateUtf8 } from "./security.js";
import { appendSessionArchiveState } from "./session-metadata.js";
import { SessionSocketHub, type SocketAttachOptions } from "./session-socket-hub.js";
import {
  conversationForTitle,
  type SessionTitleGenerator,
  type TitleConversation,
} from "./session-title-generator.js";
import { SessionView } from "./session-view.js";
const MAX_BROWSER_MODELS = 2_000;
const MAX_BROWSER_COMMANDS = 2_000;
const MAX_MODEL_FIELD_LENGTH = 256;
const PERMISSIONS_NOTICE =
  "Pi tools run with the host permissions of the current OS user. Pilot is not a filesystem or process sandbox.";

export interface RuntimeHostOptions {
  project: Project;
  manager: SessionManager;
  agentDir: string;
  log: FastifyBaseLogger;
  titleGenerator?: SessionTitleGenerator;
  onRuntimeChange?: () => void;
}

type PiModel = NonNullable<AgentSession["model"]>;

function publicModel(model: PiModel): SafeModel {
  return {
    provider: model.provider,
    id: model.id,
    name: truncateUtf8(model.name ?? model.id, 1_024, "…"),
    reasoning: model.reasoning === true,
    supportsImages: model.input.includes("image"),
    contextWindow:
      typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
        ? model.contextWindow
        : 0,
  };
}

function commandAction(command: ClientCommand): string {
  switch (command.type) {
    case "prompt":
      return "Send prompt";
    case "abort":
      return "Stop run";
    case "update_queued_message":
      return "Update queued message";
    case "delete_queued_message":
      return "Delete queued message";
    case "clear_queued_messages":
      return "Clear queued messages";
    case "set_model":
      return "Change model";
    case "set_thinking_level":
      return "Change thinking level";
    case "compact":
      return "Compact context";
    case "refresh":
      return "Refresh session";
    case "ping":
      return "Ping";
  }
}

export class RuntimeHost {
  readonly sessionId: string;
  readonly project: Project;
  private readonly runtime: AgentSessionRuntime;
  private readonly log: FastifyBaseLogger;
  private readonly onRuntimeChange?: () => void;
  private readonly state = new RuntimeStateTracker();
  private readonly view: SessionView;
  private readonly sockets: SessionSocketHub;
  private unsubscribe?: () => void;
  private disposed = false;
  private lastAccessAt = Date.now();
  private models: SafeModel[] = [];
  private readonly messageQueue: NativeMessageQueue;
  private readonly live: LiveSessionProjector;
  private readonly commandController: RuntimeCommandController;
  private readonly titleGenerator?: SessionTitleGenerator;
  private readonly titleAbortController = new AbortController();
  private titleGenerationAttempted = false;
  private titleGenerationTask?: Promise<void>;

  private constructor(options: RuntimeHostOptions, runtime: AgentSessionRuntime) {
    this.project = options.project;
    this.runtime = runtime;
    this.sessionId = runtime.session.sessionId;
    this.log = options.log;
    this.titleGenerator = options.titleGenerator;
    this.onRuntimeChange = options.onRuntimeChange;
    this.view = new SessionView(runtime.session.sessionManager, false);
    this.sockets = new SessionSocketHub({
      sessionId: this.sessionId,
      log: this.log,
      context: { sessionId: this.sessionId, projectId: this.project.id },
      snapshot: () => this.snapshot(),
      execute: (command) => this.executeCommand(command),
      touch: () => this.touch(),
    });
    this.messageQueue = new NativeMessageQueue({
      session: runtime.session,
      onChange: (queue) => {
        this.state.setQueueDepth(queue.messages.length);
        this.sockets.broadcast({ type: "queue_updated", queue });
        this.emitRuntime();
      },
      onRestoreError: (error) => {
        this.log.error(
          {
            sessionId: this.sessionId,
            projectId: this.project.id,
            error: safeLogMessage(error),
          },
          "Failed to restore Pi message queue after a mutation error",
        );
      },
    });
    this.live = new LiveSessionProjector({
      view: this.view,
      sockets: this.sockets,
      state: this.state,
      isIdle: () => this.isIdle,
      syncView: (isBusy) => this.syncView(isBusy),
      setError: (action, error) => this.setError(action, error),
    });
    this.commandController = new RuntimeCommandController({
      session: runtime.session,
      state: this.state,
      messageQueue: this.messageQueue,
      isDisposed: () => this.disposed,
      isIdle: () => this.isIdle,
      ensureAvailable: () => this.ensureAvailable(),
      ensureIdle: (action) => this.ensureIdle(action),
      emitRuntime: () => this.emitRuntime(),
      syncView: (isBusy) => this.syncView(isBusy),
      touch: () => this.touch(),
      setError: (action, error) => this.setError(action, error),
      setModel: (provider, modelId) => this.setModel(provider, modelId),
      setThinkingLevel: (level) => this.setThinkingLevel(level),
      refresh: async () => {
        await this.refreshModels();
        this.sendFreshSnapshot();
      },
    });
  }

  static async create(options: RuntimeHostOptions): Promise<RuntimeHost> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir: options.agentDir });
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.project.path,
      agentDir: options.agentDir,
      sessionManager: options.manager,
    });
    const host = new RuntimeHost(options, runtime);
    await host.initialize();
    return host;
  }

  private get session() {
    return this.runtime.session;
  }

  private async initialize(): Promise<void> {
    this.unsubscribe = this.session.subscribe((event) => this.onSessionEvent(event));
    const fallbackUI = this.session.extensionRunner.getUIContext();
    const uiContext: ExtensionUIContext = new Proxy(fallbackUI, {
      get: (target, property, receiver) =>
        property === "notify"
          ? (message: string, tone: "info" | "warning" | "error" = "info") =>
              this.notify(tone, message)
          : Reflect.get(target, property, receiver),
    });
    await this.session.bindExtensions({
      mode: "json",
      uiContext,
      onError: (issue) => {
        const value = issue as { extensionPath?: string; event?: string; error?: string };
        this.log.warn(
          {
            sessionId: this.sessionId,
            projectId: this.project.id,
            extension: value.extensionPath,
            event: value.event,
            error: truncateUtf8(value.error ?? "Extension error", 2_048, "…"),
          },
          "Pi extension error",
        );
        this.notify(
          "warning",
          `Extension ${value.event ?? "operation"} failed: ${truncateUtf8(value.error ?? "Unknown error", 1_024, "…")}`,
        );
      },
    });
    for (const diagnostic of this.runtime.diagnostics) {
      this.log[
        diagnostic.type === "error" ? "error" : diagnostic.type === "warning" ? "warn" : "info"
      ](
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          detail: truncateUtf8(diagnostic.message, 2_048, "…"),
        },
        "Pi runtime diagnostic",
      );
    }
    await this.refreshModels();
    this.restoreErrorState();
  }

  private restoreErrorState(): void {
    const lastAssistant = [...this.session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "error") {
      this.state.setError({
        action: "Previous run",
        message: truncateUtf8(
          lastAssistant.errorMessage ?? "The previous model request failed",
          16 * 1024,
        ),
        at: lastAssistant.timestamp ?? Date.now(),
      });
    }
  }

  private async refreshModels(): Promise<void> {
    const available = await this.runtime.services.modelRuntime.getAvailable();
    const sorted = available
      .filter(
        (model) =>
          model.provider.length <= MAX_MODEL_FIELD_LENGTH &&
          model.id.length <= MAX_MODEL_FIELD_LENGTH,
      )
      .map(publicModel)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    this.models = sorted.slice(0, MAX_BROWSER_MODELS);
    const current = this.currentModel();
    if (
      current &&
      !this.models.some((model) => model.provider === current.provider && model.id === current.id)
    ) {
      const selected = sorted.find(
        (model) => model.provider === current.provider && model.id === current.id,
      );
      if (selected) this.models = [selected, ...this.models.slice(0, MAX_BROWSER_MODELS - 1)];
    }
  }

  private touch(): void {
    this.lastAccessAt = Date.now();
  }

  get clientCount(): number {
    return this.sockets.clientCount;
  }

  get lastActivity(): number {
    return this.lastAccessAt;
  }

  private sessionImageSize(): number {
    let bytes = 0;
    for (const message of this.session.messages) {
      const content = "content" in message ? message.content : undefined;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "image" && typeof part.data === "string") bytes += part.data.length;
      }
    }
    return bytes;
  }

  estimatedSize(): number {
    return (
      this.view.estimatedSize() +
      Buffer.byteLength(
        JSON.stringify({
          streamingMessage: this.live.streamingMessage,
          queue: this.messageQueue.snapshot(),
          models: this.models,
          commands: this.commands(),
          contextUsage: this.contextUsage(),
        }),
        "utf8",
      ) +
      this.messageQueue.estimatedImageSize() +
      this.sessionImageSize()
    );
  }

  get isIdle(): boolean {
    return this.state.isIdle(this.session);
  }

  canDispose(now: number, idleMs: number): boolean {
    return this.clientCount === 0 && this.isIdle && now - this.lastAccessAt >= idleMs;
  }

  status(): { status: SessionStatus; phase: RuntimePhase } {
    const runtime = this.runtimeState();
    return { status: runtime.status, phase: runtime.phase };
  }

  attach(socket: WebSocket, options?: SocketAttachOptions): void {
    if (this.disposed) {
      socket.close(1012, "Session runtime is restarting");
      return;
    }
    this.sockets.attach(socket, options);
  }

  private currentModel(): { provider: string; id: string } | null {
    const model = this.session.model;
    return model ? { provider: model.provider, id: model.id } : null;
  }

  private thinkingLevel(): ThinkingLevel {
    return this.session.thinkingLevel;
  }

  private thinkingLevels(): ThinkingLevel[] {
    return this.session.getAvailableThinkingLevels();
  }

  private contextUsage(): ContextUsage | null {
    const usage = this.session.getContextUsage();
    if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow < 0) return null;
    const tokens = usage.tokens !== null && Number.isFinite(usage.tokens) ? usage.tokens : null;
    const percent = usage.percent !== null && Number.isFinite(usage.percent) ? usage.percent : null;
    return {
      tokens: tokens === null ? null : Math.max(0, tokens),
      contextWindow: usage.contextWindow,
      percent: percent === null ? null : Math.max(0, percent),
    };
  }

  private commands(): SlashCommandSummary[] {
    const commands: SlashCommandSummary[] = [];
    for (const command of this.session.extensionRunner.getRegisteredCommands()) {
      commands.push({
        name: command.invocationName,
        ...(command.description
          ? { description: truncateUtf8(command.description, 2_048, "…") }
          : {}),
        source: "extension",
      });
    }
    for (const template of this.session.promptTemplates) {
      commands.push({
        name: template.name,
        description: truncateUtf8(template.description, 2_048, "…"),
        source: "prompt",
      });
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: truncateUtf8(skill.description, 2_048, "…"),
        source: "skill",
      });
    }
    return commands
      .filter(
        (command) =>
          command.name.length > 0 && command.name.length <= 256 && !/[\s/]/.test(command.name),
      )
      .slice(0, MAX_BROWSER_COMMANDS);
  }

  private runtimeState() {
    return this.state.snapshot(this.session);
  }

  snapshot(): SessionSnapshot {
    this.view.sync(!this.isIdle);
    this.messageQueue.syncFromSession(false);
    this.state.setQueueDepth(this.messageQueue.depth);
    const projected = this.view.snapshot();
    return {
      identity: {
        id: this.sessionId,
        projectId: this.project.id,
        projectName: this.project.name,
        projectPath: this.project.path,
        ...(this.session.sessionName
          ? { name: truncateUtf8(this.session.sessionName, 512, "…") }
          : {}),
      },
      transcript: projected.transcript,
      streamingMessage: this.live.streamingMessage,
      tools: projected.tools,
      runtime: this.runtimeState(),
      queue: this.messageQueue.snapshot(),
      models: this.models,
      currentModel: this.currentModel(),
      thinkingLevel: this.thinkingLevel(),
      thinkingLevels: this.thinkingLevels(),
      contextUsage: this.contextUsage(),
      commands: this.commands(),
      permissionsNotice: PERMISSIONS_NOTICE,
      truncated: projected.truncated,
    };
  }

  renameSession(name: string): void {
    this.ensureAvailable();
    this.titleAbortController.abort();
    this.session.setSessionName(name);
    this.touch();
  }

  private maybeGenerateTitle(message: unknown): void {
    if (
      !this.titleGenerator ||
      this.disposed ||
      this.titleGenerationAttempted ||
      this.session.sessionName
    ) {
      return;
    }
    const conversation = conversationForTitle([message]);
    if (!conversation) return;

    this.titleGenerationAttempted = true;
    const task = this.generateTitle(conversation);
    this.titleGenerationTask = task;
    void task.finally(() => {
      if (this.titleGenerationTask === task) this.titleGenerationTask = undefined;
    });
  }

  private async generateTitle(conversation: TitleConversation): Promise<void> {
    const generator = this.titleGenerator;
    if (!generator) return;
    try {
      const title = await generator.generate(
        this.runtime.services.modelRuntime,
        conversation,
        this.titleAbortController.signal,
      );
      if (this.disposed || this.titleAbortController.signal.aborted || this.session.sessionName) {
        return;
      }
      this.session.setSessionName(title);
      this.touch();
      this.log.debug(
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          provider: generator.options.model.provider,
          modelId: generator.options.model.id,
          titleCharacters: Array.from(title).length,
        },
        "Generated Pi session title",
      );
    } catch (error) {
      if (this.titleAbortController.signal.aborted || this.disposed) return;
      this.log.warn(
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          provider: generator.options.model.provider,
          modelId: generator.options.model.id,
          error: safeLogMessage(error),
        },
        "Pi session title generation failed",
      );
    }
  }

  setSessionArchived(archived: boolean): void {
    this.ensureAvailable();
    this.ensureIdle(archived ? "Archive session" : "Unarchive session");
    appendSessionArchiveState(this.session.sessionManager, archived);
    this.touch();
  }

  private ensureAvailable(): void {
    if (this.disposed)
      throw new AppError(
        503,
        "runtime_disposed",
        "Session runtime is restarting; reconnect shortly",
      );
  }

  private ensureIdle(action: string): void {
    if (!this.isIdle)
      throw new AppError(
        409,
        "session_busy",
        `${action} is unavailable while the session is running`,
      );
  }

  private setError(action: string, error: unknown): void {
    const runtimeError: RuntimeError = {
      action,
      message: truncateUtf8(errorMessage(error), 16 * 1024),
      at: Date.now(),
    };
    this.state.setError(runtimeError);
    this.log.error(
      {
        sessionId: this.sessionId,
        projectId: this.project.id,
        action,
        error: safeLogMessage(error),
      },
      "Pi session operation failed",
    );
    this.emitRuntime();
  }

  private async executeCommand(command: ClientCommand): Promise<JsonValue> {
    try {
      return await this.commandController.execute(command);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const action = commandAction(command);
      this.log.error(
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          action,
          error: safeLogMessage(error),
        },
        "Session command failed",
      );
      throw new AppError(
        500,
        "command_failed",
        `${action} failed. Check the server log for details.`,
      );
    }
  }

  private async setModel(provider: string, modelId: string): Promise<void> {
    this.ensureIdle("Changing the model");
    const operation = this.state.begin("set-model");
    try {
      const available = await this.runtime.services.modelRuntime.getAvailable();
      const model = available.find(
        (candidate) => candidate.provider === provider && candidate.id === modelId,
      );
      if (!model)
        throw new AppError(
          404,
          "model_unavailable",
          "That model is unavailable or has no configured authentication",
        );
      await this.session.setModel(model);
      this.state.clearError();
      await this.refreshModels();
    } finally {
      this.state.end(operation);
      this.emitRuntime();
    }
  }

  private setThinkingLevel(level: ThinkingLevel): void {
    this.ensureIdle("Changing the thinking level");
    if (!this.thinkingLevels().includes(level)) {
      throw new AppError(
        400,
        "thinking_level_unavailable",
        "That thinking level is not supported by the selected model",
      );
    }
    this.session.setThinkingLevel(level);
    this.state.clearError();
    this.emitRuntime();
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    if (this.disposed) return;
    this.touch();
    try {
      switch (event.type) {
        case "agent_start":
        case "agent_end":
          this.emitRuntime();
          break;
        case "agent_settled":
          this.state.endRetry();
          this.syncView(false);
          this.emitRuntime();
          break;
        case "message_end":
          this.live.handle(event);
          this.maybeGenerateTitle(event.message);
          break;
        case "message_start":
        case "message_update":
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
          this.live.handle(event);
          break;
        case "queue_update":
          this.messageQueue.handleNativeUpdate(event.steering, event.followUp);
          break;
        case "compaction_start":
          this.emitRuntime();
          break;
        case "compaction_end":
          if (event.errorMessage && !this.state.has("abort"))
            this.setError("Compact context", event.errorMessage);
          this.syncView(!this.isIdle);
          this.emitRuntime();
          break;
        case "auto_retry_start":
          this.state.startRetry(
            {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
            },
            {
              action: "Automatic retry",
              message: truncateUtf8(event.errorMessage, 16 * 1024),
              at: Date.now(),
            },
          );
          this.emitRuntime();
          break;
        case "auto_retry_end":
          this.state.endRetry();
          if (event.success) this.state.clearError();
          else if (event.finalError) this.setError("Automatic retry", event.finalError);
          this.emitRuntime();
          break;
        case "thinking_level_changed":
          this.emitRuntime();
          break;
        case "entry_appended":
          queueMicrotask(() => this.syncView(!this.isIdle));
          break;
        case "session_info_changed":
          queueMicrotask(() => this.sendFreshSnapshot());
          break;
        case "turn_start":
        case "turn_end":
          break;
      }
    } catch (error) {
      this.log.error(
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          event: event.type,
          error: safeLogMessage(error),
        },
        "Failed to project Pi session event",
      );
    }
  }

  private emitRuntime(): void {
    this.sockets.broadcast({
      type: "runtime_updated",
      runtime: this.runtimeState(),
      currentModel: this.currentModel(),
      thinkingLevel: this.thinkingLevel(),
      thinkingLevels: this.thinkingLevels(),
      contextUsage: this.contextUsage(),
    });
    this.onRuntimeChange?.();
  }

  private syncView(isBusy: boolean): void {
    try {
      const change = this.view.sync(isBusy);
      if (!change) return;
      if (change.type === "replace") {
        this.sockets.broadcast({
          type: "transcript_updated",
          transcript: change.projection.transcript,
          tools: change.projection.tools,
          truncated: change.projection.truncated,
        });
        return;
      }
      const { type: _type, ...delta } = change;
      this.sockets.broadcast({ type: "transcript_delta", ...delta });
    } catch (error) {
      this.log.error(
        { sessionId: this.sessionId, projectId: this.project.id, error: safeLogMessage(error) },
        "Failed to project the session transcript",
      );
    }
  }

  private sendFreshSnapshot(): void {
    try {
      this.sockets.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    } catch (error) {
      this.log.error(
        { sessionId: this.sessionId, projectId: this.project.id, error: safeLogMessage(error) },
        "Failed to refresh the canonical session snapshot",
      );
    }
  }

  private notify(tone: "info" | "warning" | "error", message: string): void {
    this.sockets.broadcast({ type: "notification", tone, message: truncateUtf8(message, 4_096) });
  }

  async dispose(reason = "idle"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.titleAbortController.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.live.dispose();
    this.sockets.closeAll(1012, "Session runtime restarting");
    try {
      await this.titleGenerationTask;
      await this.runtime.services.settingsManager.flush();
      await this.runtime.dispose();
      this.log.debug(
        { sessionId: this.sessionId, projectId: this.project.id, reason },
        "Disposed Pi session runtime",
      );
    } catch (error) {
      this.log.error(
        {
          sessionId: this.sessionId,
          projectId: this.project.id,
          reason,
          error: safeLogMessage(error),
        },
        "Failed to dispose Pi session runtime cleanly",
      );
    }
  }
}
