import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  TRANSCRIPT_LIMIT_NOTICE_ID,
  type ToolExecution,
  type TranscriptItem,
  type TranscriptNotice,
} from "../shared/protocol.js";
import {
  appendSessionEntry,
  boundProjection,
  type MutableProjection,
  type ProjectionResult,
} from "./transcript.js";

export type SessionViewChange =
  | { type: "replace"; projection: ProjectionResult }
  | {
      type: "delta";
      appended: TranscriptItem[];
      removedIds: string[];
      notice: TranscriptNotice | null;
      toolUpserts: Record<string, ToolExecution>;
      removedToolIds: string[];
      truncated: boolean;
    };

function toolsRecord(tools: ReadonlyMap<string, ToolExecution>): Record<string, ToolExecution> {
  return Object.fromEntries(tools);
}

function sameTool(left: ToolExecution | undefined, right: ToolExecution): boolean {
  return left === right || (left !== undefined && JSON.stringify(left) === JSON.stringify(right));
}

export class SessionView {
  private leafId: string | null = null;
  private transcript: TranscriptItem[] = [];
  private tools = new Map<string, ToolExecution>();
  private busy = false;
  private truncated = false;
  private transcriptTruncated = false;
  private estimatedBytes?: number;

  constructor(
    private readonly manager: SessionManager,
    isBusy: boolean,
  ) {
    this.rebuild(isBusy);
  }

  snapshot(): ProjectionResult {
    return {
      transcript: this.transcript,
      tools: toolsRecord(this.tools),
      truncated: this.truncated,
      transcriptTruncated: this.transcriptTruncated,
    };
  }

  getTool(id: string): ToolExecution | undefined {
    return this.tools.get(id);
  }

  updateTool(tool: ToolExecution): void {
    this.tools.set(tool.id, tool);
    this.estimatedBytes = undefined;
  }

  estimatedSize(): number {
    this.estimatedBytes ??= Buffer.byteLength(
      JSON.stringify({ transcript: this.transcript, tools: [...this.tools] }),
      "utf8",
    );
    return this.estimatedBytes;
  }

  private rebuild(isBusy: boolean): ProjectionResult {
    const entries = this.manager.getBranch();
    const mutable: MutableProjection = { transcript: [], tools: new Map() };
    for (const entry of entries) appendSessionEntry(mutable, entry);
    const projected = boundProjection(mutable, isBusy);
    this.leafId = entries.at(-1)?.id ?? null;
    this.transcript = projected.transcript;
    this.tools = new Map(Object.entries(projected.tools).reverse());
    this.busy = isBusy;
    this.truncated = projected.truncated;
    this.transcriptTruncated = projected.transcriptTruncated;
    this.estimatedBytes = undefined;
    return projected;
  }

  private appendedEntries(): SessionEntry[] | null {
    const leaf = this.manager.getLeafEntry();
    if (!leaf) return this.leafId === null ? [] : null;
    if (leaf.id === this.leafId) return [];

    const appended: SessionEntry[] = [];
    let entry: SessionEntry | undefined = leaf;
    let foundPreviousLeaf = false;
    while (entry) {
      if (entry.id === this.leafId) {
        foundPreviousLeaf = true;
        break;
      }
      appended.push(entry);
      const parentId: string | null =
        "parentId" in entry && typeof entry.parentId === "string" ? entry.parentId : null;
      entry = parentId ? this.manager.getEntry(parentId) : undefined;
    }

    if (this.leafId !== null && !foundPreviousLeaf) return null;
    return appended.reverse();
  }

  sync(isBusy: boolean): SessionViewChange | null {
    const appendedEntries = this.appendedEntries();
    if (appendedEntries === null) {
      return { type: "replace", projection: this.rebuild(isBusy) };
    }
    if (appendedEntries.length === 0 && this.busy === isBusy) return null;

    const previousTranscript = this.transcript;
    const previousTools = this.tools;
    const previousTruncated = this.truncated;
    const mutable: MutableProjection = {
      transcript: [...this.transcript],
      tools: new Map(this.tools),
    };
    for (const entry of appendedEntries) appendSessionEntry(mutable, entry);
    const projected = boundProjection(mutable, isBusy, this.transcriptTruncated);

    this.leafId = appendedEntries.at(-1)?.id ?? this.leafId;
    this.transcript = projected.transcript;
    this.tools = new Map(Object.entries(projected.tools).reverse());
    this.busy = isBusy;
    this.truncated = projected.truncated;
    this.transcriptTruncated = projected.transcriptTruncated;
    this.estimatedBytes = undefined;

    const previousItems = new Set(
      previousTranscript
        .filter((item) => item.id !== TRANSCRIPT_LIMIT_NOTICE_ID)
        .map((item) => item.id),
    );
    const nextItems = new Set(
      this.transcript
        .filter((item) => item.id !== TRANSCRIPT_LIMIT_NOTICE_ID)
        .map((item) => item.id),
    );
    const removedIds = [...previousItems].filter((id) => !nextItems.has(id));
    const appended = this.transcript.filter(
      (item) => item.id !== TRANSCRIPT_LIMIT_NOTICE_ID && !previousItems.has(item.id),
    );
    const notice =
      this.transcript.find(
        (item): item is TranscriptNotice => item.id === TRANSCRIPT_LIMIT_NOTICE_ID,
      ) ?? null;

    const toolUpserts: Record<string, ToolExecution> = Object.create(null) as Record<
      string,
      ToolExecution
    >;
    for (const [id, tool] of this.tools) {
      if (!sameTool(previousTools.get(id), tool)) toolUpserts[id] = tool;
    }
    const removedToolIds = [...previousTools.keys()].filter((id) => !this.tools.has(id));

    if (
      appended.length === 0 &&
      removedIds.length === 0 &&
      Object.keys(toolUpserts).length === 0 &&
      removedToolIds.length === 0 &&
      previousTruncated === this.truncated
    ) {
      return null;
    }
    return {
      type: "delta",
      appended,
      removedIds,
      notice,
      toolUpserts,
      removedToolIds,
      truncated: this.truncated,
    };
  }
}
