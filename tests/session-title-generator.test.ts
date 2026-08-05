import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  conversationForTitle,
  sanitizeGeneratedTitle,
  SessionTitleGenerator,
} from "../src/server/session-title-generator.js";

function modelRuntimeWithResponse(response: unknown) {
  const completeSimple = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => response);
  return {
    runtime: {
      getModel: vi.fn<(...args: unknown[]) => { provider: string; id: string }>(() => ({
        provider: "openai-codex",
        id: "gpt-5.6-luna",
      })),
      hasConfiguredAuth: vi.fn<(...args: unknown[]) => boolean>(() => true),
      completeSimple,
    } as unknown as ModelRuntime,
    completeSimple,
  };
}

describe("session title generation", () => {
  it("selects the first user message without waiting for an assistant response", () => {
    expect(
      conversationForTitle([
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
        { role: "user", content: [{ type: "text", text: "Implement title generation" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Temporary failure" }],
          stopReason: "error",
        },
      ]),
    ).toEqual({ user: "Implement title generation" });
  });

  it("normalizes wrappers and enforces the character limit", () => {
    const title = sanitizeGeneratedTitle(
      'Title: "Implement automatic session title generation"\nExtra explanation',
      30,
    );
    expect(title).toBe("Implement automatic session ti");
    expect(Array.from(title)).toHaveLength(30);
  });

  it("uses the configured model through ModelRuntime.completeSimple", async () => {
    const { runtime, completeSimple } = modelRuntimeWithResponse({
      stopReason: "stop",
      content: [{ type: "text", text: "Title: Session title generation" }],
    });
    const generator = new SessionTitleGenerator({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      maxCharacters: 30,
    });

    await expect(generator.generate(runtime, { user: "Add titles" })).resolves.toBe(
      "Session title generation",
    );
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(completeSimple.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    });
    expect(completeSimple.mock.calls[0]?.[1]).toMatchObject({ tools: [] });
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({
      reasoning: "minimal",
      maxTokens: 128,
      maxRetries: 1,
    });
  });

  it("does not throttle concurrent title requests", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const completeSimple = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => response);
    const runtime = {
      getModel: vi.fn<(...args: unknown[]) => { provider: string; id: string }>(() => ({
        provider: "openai-codex",
        id: "gpt-5.6-luna",
      })),
      hasConfiguredAuth: vi.fn<(...args: unknown[]) => boolean>(() => true),
      completeSimple,
    } as unknown as ModelRuntime;
    const generator = new SessionTitleGenerator({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      maxCharacters: 30,
    });

    const requests = Array.from({ length: 5 }, (_, index) =>
      generator.generate(runtime, { user: `Request ${index}` }),
    );
    expect(completeSimple).toHaveBeenCalledTimes(5);

    resolveResponse?.({
      stopReason: "stop",
      content: [{ type: "text", text: "Generated title" }],
    });
    await expect(Promise.all(requests)).resolves.toEqual(Array(5).fill("Generated title"));
  });

  it("surfaces provider request errors without producing a title", async () => {
    const { runtime } = modelRuntimeWithResponse({
      stopReason: "error",
      errorMessage: "request failed",
      content: [],
    });
    const generator = new SessionTitleGenerator({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      maxCharacters: 30,
    });

    await expect(generator.generate(runtime, { user: "Add titles" })).rejects.toThrow(
      "request failed",
    );
  });
});
