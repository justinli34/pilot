import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MainView, ToastRegion } from "../src/client/components/MainView.js";
import { TranscriptView } from "../src/client/components/TranscriptView.js";
import type { RuntimeState, TranscriptItem } from "../src/shared/protocol.js";

const noop = () => {};

function toastCount(markup: string): number {
  return markup.match(/class="app-toast/g)?.length ?? 0;
}

function transcriptMarkup(transcript: TranscriptItem[], runtime: RuntimeState): string {
  return renderToStaticMarkup(
    createElement(TranscriptView, {
      transcript,
      streamingMessage: null,
      tools: {},
      runtime,
    }),
  );
}

const idleRuntime: RuntimeState = {
  phase: "idle",
  status: "idle",
  isBusy: false,
  queueDepth: 0,
  updatedAt: 1,
};

describe("client error presentation", () => {
  it("shows workspace connection errors in a toast even without an active project", () => {
    const markup = renderToStaticMarkup(
      createElement(MainView, {
        connection: "disconnected",
        workspaceError: "Could not load sessions. Retrying…",
        showSessionHeader: false,
        creatingSession: false,
        onOpenNavigation: noop,
        onAddProject: noop,
        onCreateSession: noop,
        onRestoreSession: async () => {},
        onDismissError: noop,
        sendCommand: async () => undefined,
      }),
    );

    expect(markup).toContain("Session updates unavailable");
    expect(markup).toContain("Could not load sessions. Retrying…");
    expect(toastCount(markup)).toBe(1);
  });

  it("folds a connection error notification into the connection toast", () => {
    const message = "Unable to open this session";
    const markup = renderToStaticMarkup(
      createElement(ToastRegion, {
        connection: "disconnected",
        connectionError: "The sessions stream was rejected.",
        notice: { type: "notification", tone: "error", message },
        onDismissError: noop,
        onDismissNotice: noop,
      }),
    );

    expect(markup).toContain(message);
    expect(toastCount(markup)).toBe(1);
  });

  it("does not repeat the same failure as both an error and a notification", () => {
    const message = "The action failed";
    const markup = renderToStaticMarkup(
      createElement(ToastRegion, {
        error: message,
        notice: { type: "notification", tone: "error", message },
        onDismissError: noop,
        onDismissNotice: noop,
      }),
    );

    expect(toastCount(markup)).toBe(1);
    expect(markup.match(new RegExp(message, "g"))).toHaveLength(1);
  });

  it("hides transient assistant errors while the session retries", () => {
    const message = "WebSocket error";
    const transcript: TranscriptItem[] = [
      {
        kind: "message",
        id: "assistant-error",
        role: "assistant",
        blocks: [],
        timestamp: 1,
        stopReason: "error",
        error: message,
      },
    ];

    const markup = transcriptMarkup(transcript, {
      phase: "retrying",
      status: "running",
      isBusy: true,
      retry: { attempt: 1, maxAttempts: 3, delayMs: 2_000 },
      queueDepth: 0,
      lastError: { action: "Automatic retry", message, at: 1 },
      updatedAt: 1,
    });

    expect(markup).not.toContain(message);
    expect(markup).toContain("Working for");
  });

  it("keeps recovered transient errors out of the completed transcript", () => {
    const message = "WebSocket error";
    const transcript: TranscriptItem[] = [
      {
        kind: "message",
        id: "assistant-error",
        role: "assistant",
        blocks: [],
        timestamp: 1,
        stopReason: "error",
        error: message,
      },
      {
        kind: "message",
        id: "assistant-success",
        role: "assistant",
        blocks: [{ type: "text", text: "Done" }],
        timestamp: 2,
        stopReason: "stop",
      },
    ];

    const markup = transcriptMarkup(transcript, idleRuntime);

    expect(markup).not.toContain(message);
    expect(markup).toContain("Done");
  });

  it("does not let a recovered error mask a later terminal runtime error", () => {
    const message = "WebSocket error";
    const transcript: TranscriptItem[] = [
      {
        kind: "message",
        id: "assistant-error",
        role: "assistant",
        blocks: [],
        timestamp: 1,
        stopReason: "error",
        error: message,
      },
      {
        kind: "message",
        id: "assistant-success",
        role: "assistant",
        blocks: [{ type: "text", text: "Recovered" }],
        timestamp: 2,
        stopReason: "stop",
      },
    ];

    const markup = transcriptMarkup(transcript, {
      phase: "error",
      status: "error",
      isBusy: false,
      queueDepth: 0,
      lastError: { action: "Compact context", message, at: 3 },
      updatedAt: 3,
    });

    expect(markup.match(new RegExp(message, "g"))).toHaveLength(1);
    expect(markup).toContain("Compact context");
  });

  it("shows an assistant error when it stops the session", () => {
    const message = "WebSocket error";
    const transcript: TranscriptItem[] = [
      {
        kind: "message",
        id: "assistant-error",
        role: "assistant",
        blocks: [],
        timestamp: 1,
        stopReason: "error",
        error: message,
      },
    ];

    const markup = transcriptMarkup(transcript, {
      phase: "error",
      status: "error",
      isBusy: false,
      queueDepth: 0,
      lastError: { action: "Run", message, at: 1 },
      updatedAt: 1,
    });

    expect(markup.match(new RegExp(message, "g"))).toHaveLength(1);
  });
});
