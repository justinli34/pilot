import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { SessionSnapshot, ToolExecution } from "../shared/protocol.js";
import type { RuntimeStateTracker } from "./runtime-state.js";
import type { SessionSocketHub } from "./session-socket-hub.js";
import type { SessionView } from "./session-view.js";
import {
  createAssistantDelta,
  createToolDelta,
  sameAssistantMessage,
  sameToolExecution,
} from "./stream-delta.js";
import { projectAssistantMessage, projectToolExecution } from "./transcript.js";

const ASSISTANT_UPDATE_INTERVAL_MS = 100;
const TOOL_UPDATE_INTERVAL_MS = 100;

type LiveSessionEvent = Extract<
  AgentSessionEvent,
  {
    type:
      | "message_start"
      | "message_update"
      | "message_end"
      | "tool_execution_start"
      | "tool_execution_update"
      | "tool_execution_end";
  }
>;

interface LiveSessionProjectorOptions {
  view: SessionView;
  sockets: SessionSocketHub;
  state: RuntimeStateTracker;
  isIdle: () => boolean;
  syncView: (isBusy: boolean) => void;
  setError: (action: string, error: unknown) => void;
}

export class LiveSessionProjector {
  private currentMessage: SessionSnapshot["streamingMessage"] = null;
  private publishedMessage: SessionSnapshot["streamingMessage"] = null;
  private pendingMessage?: unknown;
  private streamNumber = 0;
  private currentStreamId?: string;
  private assistantTimer?: NodeJS.Timeout;
  private readonly pendingToolUpdates = new Map<
    string,
    Extract<AgentSessionEvent, { type: "tool_execution_update" }>
  >();
  private readonly toolTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: LiveSessionProjectorOptions) {}

  get streamingMessage(): SessionSnapshot["streamingMessage"] {
    return this.currentMessage;
  }

  handle(event: LiveSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.currentStreamId = `live-${Date.now()}-${++this.streamNumber}`;
          this.pendingMessage = undefined;
          this.currentMessage = projectAssistantMessage(event.message, this.currentStreamId);
          this.publishAssistant(this.currentMessage);
        }
        break;
      case "message_update":
        if (!this.currentStreamId) {
          this.currentStreamId = `live-${Date.now()}-${++this.streamNumber}`;
        }
        this.pendingMessage = event.message;
        this.scheduleAssistantUpdate();
        break;
      case "message_end": {
        const { message } = event;
        if (message.role === "assistant") {
          if (message.stopReason === "error") {
            this.options.setError("Run", message.errorMessage ?? "Model request failed");
          }
          if (message.stopReason === "aborted" && this.options.state.lastError?.action === "Run") {
            this.options.state.clearError();
          }
        }
        queueMicrotask(() => {
          if (message.role === "assistant") {
            if (this.assistantTimer) clearTimeout(this.assistantTimer);
            this.assistantTimer = undefined;
            this.pendingMessage = undefined;
            this.currentMessage = null;
            this.currentStreamId = undefined;
            this.publishAssistant(null);
          }
          this.options.syncView(!this.options.isIdle());
        });
        break;
      }
      case "tool_execution_start": {
        this.pendingToolUpdates.delete(event.toolCallId);
        this.publishTool(projectToolExecution(event, "running"));
        break;
      }
      case "tool_execution_update":
        this.pendingToolUpdates.set(event.toolCallId, event);
        this.scheduleToolUpdate(event.toolCallId);
        break;
      case "tool_execution_end": {
        const existingTimer = this.toolTimers.get(event.toolCallId);
        if (existingTimer) clearTimeout(existingTimer);
        this.toolTimers.delete(event.toolCallId);
        this.pendingToolUpdates.delete(event.toolCallId);
        const current = this.options.view.getTool(event.toolCallId);
        this.publishTool(
          projectToolExecution(event, event.isError ? "failed" : "succeeded", current),
        );
        break;
      }
    }
  }

  private publishAssistant(message: SessionSnapshot["streamingMessage"]): void {
    if (sameAssistantMessage(this.publishedMessage, message)) return;
    const delta = createAssistantDelta(this.publishedMessage, message);
    this.options.sockets.broadcast(delta ?? { type: "assistant_updated", message });
    this.publishedMessage = message;
  }

  private publishTool(tool: ToolExecution): void {
    const previous = this.options.view.getTool(tool.id);
    if (previous && sameToolExecution(previous, tool)) return;
    this.options.view.updateTool(tool);
    const delta = createToolDelta(previous, tool);
    this.options.sockets.broadcast(delta ?? { type: "tool_updated", tool });
  }

  private scheduleAssistantUpdate(): void {
    if (this.assistantTimer) return;
    this.assistantTimer = setTimeout(() => {
      this.assistantTimer = undefined;
      const pending = this.pendingMessage;
      this.pendingMessage = undefined;
      if (!this.currentStreamId || pending === undefined) return;
      this.currentMessage = projectAssistantMessage(pending, this.currentStreamId);
      this.publishAssistant(this.currentMessage);
    }, ASSISTANT_UPDATE_INTERVAL_MS);
    this.assistantTimer.unref();
  }

  private scheduleToolUpdate(toolCallId: string): void {
    if (this.toolTimers.has(toolCallId)) return;
    const timer = setTimeout(() => {
      this.toolTimers.delete(toolCallId);
      const event = this.pendingToolUpdates.get(toolCallId);
      this.pendingToolUpdates.delete(toolCallId);
      if (!event) return;
      const current = this.options.view.getTool(toolCallId);
      this.publishTool(projectToolExecution(event, "running", current));
    }, TOOL_UPDATE_INTERVAL_MS);
    timer.unref();
    this.toolTimers.set(toolCallId, timer);
  }

  dispose(): void {
    if (this.assistantTimer) clearTimeout(this.assistantTimer);
    this.assistantTimer = undefined;
    this.pendingMessage = undefined;
    for (const timer of this.toolTimers.values()) clearTimeout(timer);
    this.toolTimers.clear();
    this.pendingToolUpdates.clear();
  }
}
