import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MainView, ToastRegion } from "../src/client/components/MainView.js";

const noop = () => {};

function toastCount(markup: string): number {
  return markup.match(/class="app-toast/g)?.length ?? 0;
}

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
});
