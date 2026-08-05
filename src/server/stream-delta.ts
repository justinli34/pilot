import type {
  AssistantDelta,
  JsonValue,
  ToolDelta,
  ToolExecution,
  TranscriptBlock,
  TranscriptMessage,
} from "../shared/protocol.js";

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sameBlock(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (left === right || left.type !== right.type) return left === right;
  switch (left.type) {
    case "text":
      return right.type === "text" && left.text === right.text;
    case "image":
      return right.type === "image" && left.mimeType === right.mimeType && left.data === right.data;
    case "thinking":
      return (
        right.type === "thinking" &&
        left.thinking === right.thinking &&
        left.redacted === right.redacted
      );
    case "tool_call":
      return (
        right.type === "tool_call" &&
        left.toolCallId === right.toolCallId &&
        left.name === right.name &&
        sameJson(left.arguments, right.arguments)
      );
  }
}

function sameMessageMetadata(left: TranscriptMessage, right: TranscriptMessage): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.timestamp === right.timestamp &&
    left.completedAt === right.completedAt &&
    left.model === right.model &&
    left.stopReason === right.stopReason &&
    left.error === right.error &&
    left.streaming === right.streaming
  );
}

export function sameAssistantMessage(
  left: TranscriptMessage | null,
  right: TranscriptMessage | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || !sameMessageMetadata(left, right)) return false;
  return (
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => {
      const next = right.blocks[index];
      return next !== undefined && sameBlock(block, next);
    })
  );
}

export function createAssistantDelta(
  previous: TranscriptMessage | null,
  next: TranscriptMessage | null,
): AssistantDelta | undefined {
  if (
    !previous ||
    !next ||
    !sameMessageMetadata(previous, next) ||
    previous.blocks.length !== next.blocks.length
  ) {
    return undefined;
  }

  let delta: AssistantDelta | undefined;
  for (let index = 0; index < previous.blocks.length; index++) {
    const before = previous.blocks[index];
    const after = next.blocks[index];
    if (!before || !after || sameBlock(before, after)) continue;
    if (delta) return undefined;

    if (before.type === "text" && after.type === "text" && after.text.startsWith(before.text)) {
      delta = {
        type: "assistant_delta",
        messageId: next.id,
        blockIndex: index,
        field: "text",
        append: after.text.slice(before.text.length),
      };
      continue;
    }
    if (
      before.type === "thinking" &&
      after.type === "thinking" &&
      before.redacted === after.redacted &&
      after.thinking.startsWith(before.thinking)
    ) {
      delta = {
        type: "assistant_delta",
        messageId: next.id,
        blockIndex: index,
        field: "thinking",
        append: after.thinking.slice(before.thinking.length),
      };
      continue;
    }
    return undefined;
  }
  return delta?.append ? delta : undefined;
}

function sameToolMetadata(left: ToolExecution, right: ToolExecution): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.status === right.status &&
    left.error === right.error &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    sameJson(left.arguments, right.arguments)
  );
}

export function sameToolExecution(left: ToolExecution, right: ToolExecution): boolean {
  return (
    sameToolMetadata(left, right) && left.output === right.output && left.patch === right.patch
  );
}

export function createToolDelta(
  previous: ToolExecution | undefined,
  next: ToolExecution,
): ToolDelta | undefined {
  if (!previous || !sameToolMetadata(previous, next)) return undefined;
  const previousPatch = previous.patch ?? "";
  const nextPatch = next.patch ?? "";
  if (!next.output.startsWith(previous.output) || !nextPatch.startsWith(previousPatch)) {
    return undefined;
  }
  const outputAppend = next.output.slice(previous.output.length);
  const patchAppend = nextPatch.slice(previousPatch.length);
  if (!outputAppend && !patchAppend) return undefined;
  return {
    type: "tool_delta",
    toolId: next.id,
    ...(outputAppend ? { outputAppend } : {}),
    ...(patchAppend ? { patchAppend } : {}),
  };
}
