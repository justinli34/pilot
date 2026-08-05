import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  TRANSCRIPT_LIMIT_NOTICE_ID,
  type ToolExecution,
  type ToolStatus,
  type TranscriptBlock,
  type TranscriptItem,
  type TranscriptMessage,
} from "../shared/protocol.js";
import { safeImageAttachment } from "./images.js";
import { sanitizeJson, truncateUtf8 } from "./security.js";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_RENDERED_IMAGE_DATA_CHARACTERS = 3 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEMS = 2_000;
const MAX_TOOL_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_VISIBLE_TOOLS = 2_000;

interface PiTextContent {
  type: "text";
  text: string;
}
interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
interface PiImageContent {
  type: "image";
  data?: unknown;
  mimeType?: unknown;
}
type PiContent =
  | PiTextContent
  | PiThinkingContent
  | PiToolCall
  | PiImageContent
  | Record<string, unknown>;

interface PiMessage {
  role: string;
  content?: string | PiContent[];
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  display?: boolean;
  customType?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
}

export interface ProjectionResult {
  transcript: TranscriptItem[];
  tools: Record<string, ToolExecution>;
  truncated: boolean;
  transcriptTruncated: boolean;
}

export interface MutableProjection {
  transcript: TranscriptItem[];
  tools: Map<string, ToolExecution>;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function entryTimestamp(entry: SessionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function contentText(content: unknown, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  if (typeof content === "string") return truncateUtf8(content, maxBytes);
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(
      (part): part is PiTextContent =>
        typeof part === "object" && part !== null && part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  return truncateUtf8(text, maxBytes);
}

function normalizeThinking(thinking: string): string {
  return thinking
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}

function contentBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string")
    return [{ type: "text", text: truncateUtf8(content, MAX_MESSAGE_BYTES) }];
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  let renderedImageDataCharacters = 0;
  for (const value of content) {
    if (typeof value !== "object" || value === null || !("type" in value)) continue;
    const part = value as PiContent;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: truncateUtf8(part.text, MAX_MESSAGE_BYTES) });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      const thinking = truncateUtf8(normalizeThinking(part.thinking), MAX_MESSAGE_BYTES);
      if (!thinking && part.redacted !== true) continue;
      blocks.push({
        type: "thinking",
        thinking,
        ...(part.redacted === true ? { redacted: true } : {}),
      });
    } else if (
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      typeof part.name === "string"
    ) {
      blocks.push({
        type: "tool_call",
        toolCallId: part.id,
        name: truncateUtf8(part.name, 1_024, "…"),
        arguments: sanitizeJson(part.arguments),
      });
    } else if (part.type === "image") {
      const image = safeImageAttachment(part);
      if (
        image &&
        renderedImageDataCharacters + image.data.length <= MAX_RENDERED_IMAGE_DATA_CHARACTERS
      ) {
        blocks.push(image);
        renderedImageDataCharacters += image.data.length;
      } else {
        blocks.push({
          type: "text",
          text: "[Image omitted from the browser transcript: invalid or too large to render.]",
        });
      }
    }
  }
  return blocks;
}

function isAbortResult(output: string): boolean {
  return /\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b/i.test(output);
}

function resultPatch(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || !("patch" in details)) return undefined;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" ? truncateUtf8(patch, MAX_PATCH_BYTES) : undefined;
}

function resultError(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || !("error" in details)) return undefined;
  const error = (details as { error?: unknown }).error;
  return typeof error === "string" ? truncateUtf8(error, 16 * 1024) : undefined;
}

function toolFromResult(message: PiMessage, previous?: ToolExecution): ToolExecution | undefined {
  if (typeof message.toolCallId !== "string") return undefined;
  const output = contentText(message.content);
  const failed = message.isError === true;
  const error = failed
    ? output || resultError(message.details) || "Tool execution failed"
    : undefined;
  const status: ToolStatus = failed
    ? isAbortResult(error ?? "")
      ? "aborted"
      : "failed"
    : "succeeded";
  const patch = resultPatch(message.details);
  return {
    id: message.toolCallId,
    name:
      typeof message.toolName === "string"
        ? truncateUtf8(message.toolName, 1_024, "…")
        : (previous?.name ?? "tool"),
    arguments: previous?.arguments ?? {},
    status,
    output,
    ...(patch ? { patch } : {}),
    ...(error ? { error } : {}),
    ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    completedAt: timestamp(message.timestamp, Date.now()),
  };
}

function messageToTranscript(
  message: PiMessage,
  id: string,
  fallbackTimestamp: number,
): TranscriptItem | undefined {
  const at = timestamp(message.timestamp, fallbackTimestamp);
  if (message.role === "user" || message.role === "assistant") {
    return {
      kind: "message",
      id,
      role: message.role,
      blocks: contentBlocks(message.content),
      timestamp: at,
      ...(message.role === "assistant" ? { completedAt: fallbackTimestamp } : {}),
      ...(message.model ? { model: `${message.provider ?? "model"}/${message.model}` } : {}),
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(message.errorMessage ? { error: truncateUtf8(message.errorMessage, 16 * 1024) } : {}),
    };
  }
  if (message.role === "custom" && message.display !== false) {
    return {
      kind: "notice",
      id,
      tone: "info",
      title: message.customType ?? "Extension",
      text: contentText(message.content, MAX_MESSAGE_BYTES),
      timestamp: at,
    };
  }
  if (message.role === "bashExecution") {
    const cancelled = message.cancelled === true;
    const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
    return {
      kind: "bash_execution",
      id,
      command: truncateUtf8(message.command ?? "", 64 * 1024),
      output: truncateUtf8(message.output ?? "", MAX_TOOL_OUTPUT_BYTES),
      status: cancelled ? "aborted" : failed ? "failed" : "succeeded",
      timestamp: at,
    };
  }
  return undefined;
}

function transcriptLimitNotice(timestamp: number): TranscriptItem {
  return {
    kind: "notice",
    id: TRANSCRIPT_LIMIT_NOTICE_ID,
    tone: "warning",
    title: "Earlier transcript omitted",
    text: "Pilot limited this browser snapshot by size or item count. The complete conversation remains in Pi's JSONL session.",
    timestamp,
  };
}

function trimTranscript(
  items: TranscriptItem[],
  previouslyTruncated = false,
): {
  transcript: TranscriptItem[];
  truncated: boolean;
} {
  const content = items.filter((item) => item.id !== TRANSCRIPT_LIMIT_NOTICE_ID);
  let bytes = 0;
  let retainedItems = 0;
  let start = content.length;
  for (let index = content.length - 1; index >= 0; index--) {
    const item = content[index];
    if (!item || retainedItems >= MAX_TRANSCRIPT_ITEMS) break;
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + itemBytes > MAX_TRANSCRIPT_BYTES) break;
    bytes += itemBytes;
    retainedItems += 1;
    start = index;
  }
  const truncated = previouslyTruncated || start > 0;
  if (!truncated) return { transcript: content, truncated: false };
  const retained = content.slice(start);
  return {
    transcript: [transcriptLimitNotice(retained[0]?.timestamp ?? Date.now()), ...retained],
    truncated: true,
  };
}

export function projectAssistantMessage(message: unknown, id: string): TranscriptMessage | null {
  if (
    typeof message !== "object" ||
    message === null ||
    (message as PiMessage).role !== "assistant"
  )
    return null;
  const piMessage = message as PiMessage;
  return {
    kind: "message",
    id,
    role: "assistant",
    blocks: contentBlocks(piMessage.content),
    timestamp: timestamp(piMessage.timestamp, Date.now()),
    ...(piMessage.model ? { model: `${piMessage.provider ?? "model"}/${piMessage.model}` } : {}),
    ...(piMessage.stopReason ? { stopReason: piMessage.stopReason } : {}),
    ...(piMessage.errorMessage ? { error: truncateUtf8(piMessage.errorMessage, 16 * 1024) } : {}),
    streaming: true,
  };
}

export function projectToolExecution(
  event: {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    result?: unknown;
    partialResult?: unknown;
    isError?: boolean;
  },
  status: ToolStatus,
  previous?: ToolExecution,
): ToolExecution {
  const result = (event.result ?? event.partialResult) as
    | { content?: unknown; details?: unknown }
    | undefined;
  const output = contentText(result?.content);
  const error =
    event.isError === true
      ? output || resultError(result?.details) || "Tool execution failed"
      : undefined;
  const effectiveStatus = status === "failed" && isAbortResult(error ?? "") ? "aborted" : status;
  const patch = resultPatch(result?.details);
  return {
    id: event.toolCallId,
    name: truncateUtf8(event.toolName, 1_024, "…"),
    arguments: event.args === undefined ? (previous?.arguments ?? {}) : sanitizeJson(event.args),
    status: effectiveStatus,
    output,
    ...(patch ? { patch } : {}),
    ...(error ? { error } : {}),
    startedAt: previous?.startedAt ?? Date.now(),
    ...(effectiveStatus !== "running" ? { completedAt: Date.now() } : {}),
  };
}

export function appendSessionEntry(projection: MutableProjection, entry: SessionEntry): void {
  const at = entryTimestamp(entry);
  let item: TranscriptItem | undefined;
  if (entry.type === "message") {
    const message = entry.message as PiMessage;
    if (message.role === "assistant") {
      for (const block of contentBlocks(message.content)) {
        if (block.type !== "tool_call" || projection.tools.has(block.toolCallId)) continue;
        projection.tools.set(block.toolCallId, {
          id: block.toolCallId,
          name: block.name,
          arguments: block.arguments,
          status: message.stopReason === "aborted" ? "aborted" : "running",
          output: "",
          startedAt: timestamp(message.timestamp, at),
        });
      }
    } else if (message.role === "toolResult") {
      const result = toolFromResult(message, projection.tools.get(message.toolCallId ?? ""));
      if (result) projection.tools.set(result.id, result);
    }
    item = messageToTranscript(message, entry.id, at);
  } else if (entry.type === "custom_message" && entry.display) {
    item = {
      kind: "notice",
      id: entry.id,
      tone: "info",
      title: entry.customType,
      text: contentText(entry.content, MAX_MESSAGE_BYTES),
      timestamp: at,
    };
  } else if (entry.type === "compaction") {
    item = {
      kind: "notice",
      id: entry.id,
      tone: "info",
      title: `Context compacted (${entry.tokensBefore.toLocaleString()} tokens)`,
      text: truncateUtf8(entry.summary, MAX_MESSAGE_BYTES),
      timestamp: at,
    };
  } else if (entry.type === "branch_summary") {
    item = {
      kind: "notice",
      id: entry.id,
      tone: "info",
      title: "Branch summary",
      text: truncateUtf8(entry.summary, MAX_MESSAGE_BYTES),
      timestamp: at,
    };
  }
  if (item) projection.transcript.push(item);
}

export function boundProjection(
  projection: MutableProjection,
  isBusy: boolean,
  previouslyTruncated = false,
): ProjectionResult {
  if (!isBusy) {
    for (const [id, tool] of projection.tools) {
      if (tool.status === "running")
        projection.tools.set(id, { ...tool, status: "aborted", completedAt: Date.now() });
    }
  }

  const trimmed = trimTranscript(projection.transcript, previouslyTruncated);
  const referencedTools = new Set<string>();
  for (const item of trimmed.transcript) {
    if (item.kind !== "message") continue;
    for (const block of item.blocks)
      if (block.type === "tool_call") referencedTools.add(block.toolCallId);
  }
  const visibleTools = Object.create(null) as Record<string, ToolExecution>;
  const candidates = [...projection.tools].filter(
    ([id, tool]) => referencedTools.has(id) || tool.status === "running",
  );
  let toolBytes = 0;
  let toolDataTruncated = candidates.length > MAX_VISIBLE_TOOLS;
  for (const [id, tool] of candidates.slice(-MAX_VISIBLE_TOOLS).reverse()) {
    const fullBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    if (toolBytes + fullBytes <= MAX_TOOL_SNAPSHOT_BYTES) {
      visibleTools[id] = tool;
      toolBytes += fullBytes;
      continue;
    }
    toolDataTruncated = true;
    const compact: ToolExecution = {
      ...tool,
      arguments: "[Arguments omitted: browser snapshot limit reached]",
      output: "[Tool output omitted: browser snapshot limit reached]",
      ...(tool.error ? { error: truncateUtf8(tool.error, 1_024, "…") } : {}),
    };
    delete compact.patch;
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
    if (toolBytes + compactBytes <= MAX_TOOL_SNAPSHOT_BYTES) {
      visibleTools[id] = compact;
      toolBytes += compactBytes;
    }
  }
  return {
    transcript: trimmed.transcript,
    tools: visibleTools,
    truncated: trimmed.truncated || toolDataTruncated,
    transcriptTruncated: trimmed.truncated,
  };
}

export function projectSession(manager: SessionManager, isBusy: boolean): ProjectionResult {
  const projection: MutableProjection = { transcript: [], tools: new Map() };
  for (const entry of manager.getBranch()) appendSessionEntry(projection, entry);
  return boundProjection(projection, isBusy);
}
