import type { TranscriptItem, TranscriptMessage } from "../shared/protocol.js";

export interface TranscriptMessageSection {
  kind: "messages";
  id: string;
  role: TranscriptMessage["role"];
  messages: TranscriptMessage[];
  turnStartedAt?: number;
}

export interface TranscriptItemSection {
  kind: "item";
  id: string;
  item: Exclude<TranscriptItem, { kind: "message" }>;
}

export type TranscriptSection = TranscriptMessageSection | TranscriptItemSection;

function appendSection(
  sections: TranscriptSection[],
  item: TranscriptItem,
  turnStartedAt?: number,
): void {
  if (item.kind !== "message") {
    sections.push({ kind: "item", id: item.id, item });
    return;
  }

  const previous = sections.at(-1);
  if (item.role === "assistant" && previous?.kind === "messages" && previous.role === "assistant") {
    previous.messages.push(item);
    return;
  }

  sections.push({
    kind: "messages",
    id: item.id,
    role: item.role,
    messages: [item],
    ...(item.role === "assistant" && turnStartedAt !== undefined ? { turnStartedAt } : {}),
  });
}

export function groupTranscriptSections(
  transcript: readonly TranscriptItem[],
  streamingMessage: TranscriptMessage | null,
): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  let turnStartedAt: number | undefined;
  for (const item of transcript) {
    appendSection(sections, item, turnStartedAt);
    if (item.kind === "message" && item.role === "user") turnStartedAt = item.timestamp;
  }
  if (streamingMessage) appendSection(sections, streamingMessage, turnStartedAt);
  return sections;
}
