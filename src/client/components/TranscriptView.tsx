import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  RuntimeState,
  ToolExecution,
  TranscriptBlock,
  TranscriptItem,
  TranscriptMessage,
} from "../../shared/protocol.js";
import { readCssPixelToken } from "../design-system.js";
import { groupTranscriptSections, type TranscriptSection } from "../transcript-sections.js";
import { Markdown } from "./Markdown.js";
import { ToolCard } from "./ToolCard.js";
import { VirtualBlock, useVisibilityObserver } from "./VirtualBlock.js";

interface TranscriptViewProps {
  transcript: TranscriptItem[];
  streamingMessage: TranscriptMessage | null;
  tools: Record<string, ToolExecution>;
  runtime: RuntimeState;
}

function transcriptRepresentsError(transcript: TranscriptItem[], error: string): boolean {
  const currentTurn = transcript.slice(
    transcript.findLastIndex((item) => item.kind === "message" && item.role === "user") + 1,
  );
  const lastAssistant = currentTurn.findLast(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  if (lastAssistant?.kind === "message" && lastAssistant.error === error) return true;
  return currentTurn.some(
    (item) => item.kind === "notice" && (item.text.includes(error) || item.title.includes(error)),
  );
}

function fallbackTool(
  block: Extract<TranscriptBlock, { type: "tool_call" }>,
  busy: boolean,
): ToolExecution {
  return {
    id: block.toolCallId,
    name: block.name,
    arguments: block.arguments,
    status: busy ? "running" : "aborted",
    output: "",
  };
}

type StepBlock = Extract<TranscriptBlock, { type: "thinking" | "tool_call" }>;

function isRenderableStep(block: TranscriptBlock): block is StepBlock {
  return (
    block.type === "tool_call" ||
    (block.type === "thinking" && (block.redacted === true || block.thinking.trim().length > 0))
  );
}

interface StepItem {
  key: string;
  block: StepBlock;
}

function lastRenderableStepKey(messages: readonly TranscriptMessage[]): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.blocks[blockIndex];
      if (!block || !isRenderableStep(block)) continue;
      return `${message.id}-${block.type}-${blockIndex}`;
    }
  }
  return undefined;
}

const THINKING_VIRTUALIZE_THRESHOLD = 80;
const THINKING_CHUNK_LINES = 32;
const THINKING_OVERSCAN_PX = 320;

const ThinkingMarkdown = memo(function ThinkingMarkdown({
  itemKey,
  text,
  redacted,
  streaming,
}: {
  itemKey: string;
  text: string;
  redacted: boolean;
  streaming: boolean;
}) {
  const lines = useMemo(
    () => (redacted ? ["[Redacted thinking]"] : text.trim().split("\n")),
    [redacted, text],
  );
  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let index = 0; index < lines.length; index += THINKING_CHUNK_LINES) {
      result.push(lines.slice(index, index + THINKING_CHUNK_LINES));
    }
    return result;
  }, [lines]);
  const virtualized = lines.length > THINKING_VIRTUALIZE_THRESHOLD;
  const container = useRef<HTMLDivElement>(null);
  const visibility = useVisibilityObserver(container, virtualized, THINKING_OVERSCAN_PX);

  return (
    <div className="step-thinking" ref={container}>
      {chunks.map((chunk, chunkIndex) => {
        const start = chunkIndex * THINKING_CHUNK_LINES;
        return (
          <VirtualBlock
            className="step-thinking-chunk"
            key={`${itemKey}-chunk-${start}`}
            observer={visibility}
            initiallyVisible={chunkIndex === 0}
            estimatedHeight={`calc(${chunk.length} * var(--control-height-md))`}
          >
            {chunk.map((line, lineIndex) => {
              const index = start + lineIndex;
              return (
                <div className="step-thinking-line" key={`${itemKey}-line-${index}`}>
                  <Markdown streaming={streaming}>{line}</Markdown>
                </div>
              );
            })}
          </VirtualBlock>
        );
      })}
    </div>
  );
});

function useLiveElapsed(active: boolean, startedAt: number | undefined): number | undefined {
  const fallbackStartedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  return active ? Math.max(0, now - (startedAt ?? fallbackStartedAt.current)) : undefined;
}

function StepsDisclosure({
  items,
  tools,
  active,
  startedAt,
  elapsed,
}: {
  items: StepItem[];
  tools: Record<string, ToolExecution>;
  active: boolean;
  startedAt: number | undefined;
  elapsed: number | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const liveElapsed = useLiveElapsed(active, startedAt);
  const summary = active
    ? `Working for ${formatElapsedTime(liveElapsed ?? 0)}`
    : elapsed === undefined
      ? "Worked"
      : `Worked for ${formatElapsedTime(elapsed)}`;

  return (
    <div
      className={`steps-disclosure${active ? " steps-active" : ""}`}
      role={active ? "status" : undefined}
      aria-live={active ? "polite" : undefined}
    >
      {expanded && (
        <button
          className="steps-gutter"
          type="button"
          aria-label="Collapse steps"
          onClick={() => setExpanded(false)}
        />
      )}
      <button
        className="steps-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{summary}</span>
        <ChevronRight className={expanded ? "chevron expanded" : "chevron"} size={14} />
      </button>
      {expanded && (
        <div className="steps-content">
          {items.map((item) =>
            item.block.type === "thinking" ? (
              <ThinkingMarkdown
                key={item.key}
                itemKey={item.key}
                text={item.block.thinking}
                redacted={item.block.redacted === true}
                streaming={active}
              />
            ) : (
              <ToolCard
                key={item.key}
                tool={tools[item.block.toolCallId] ?? fallbackTool(item.block, active)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function WorkingIndicator({ startedAt }: { startedAt: number | undefined }) {
  const elapsed = useLiveElapsed(true, startedAt) ?? 0;
  return (
    <div className="working-indicator" role="status" aria-live="polite">
      <span>Working for {formatElapsedTime(elapsed)}</span>
    </div>
  );
}

function messageError(message: TranscriptMessage): ReactNode {
  return message.error ? (
    <div className="message-error" key={`${message.id}-error`}>
      <AlertTriangle size={14} /> {message.error}
    </div>
  ) : null;
}

function UserMessageContent({ message }: { message: TranscriptMessage }) {
  const images = message.blocks.filter(
    (block): block is Extract<TranscriptBlock, { type: "image" }> => block.type === "image",
  );
  return (
    <>
      {images.length > 0 && (
        <div
          className="user-images"
          aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`}
        >
          {images.map((image, index) => (
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`Attached image ${index + 1}`}
              loading="lazy"
              decoding="async"
              key={`${message.id}-image-${index}`}
            />
          ))}
        </div>
      )}
      {message.blocks.map((block, index) =>
        block.type === "text" && block.text ? (
          <div className="user-text" key={`${message.id}-text-${index}`}>
            {block.text}
          </div>
        ) : null,
      )}
      {messageError(message)}
    </>
  );
}

function AssistantMessagesContent({
  messages,
  tools,
  active,
  startedAt,
  elapsed,
}: {
  messages: readonly TranscriptMessage[];
  tools: Record<string, ToolExecution>;
  active: boolean;
  startedAt: number | undefined;
  elapsed: number | undefined;
}) {
  const content: ReactNode[] = [];
  const activeStepKey = active ? lastRenderableStepKey(messages) : undefined;

  let pendingSteps: StepItem[] = [];
  const flushSteps = () => {
    if (pendingSteps.length === 0) return;
    const items = pendingSteps;
    pendingSteps = [];
    const stepsActive =
      activeStepKey !== undefined && items.some((item) => item.key === activeStepKey);
    content.push(
      <StepsDisclosure
        key={`steps-${items[0]?.key}`}
        items={items}
        tools={tools}
        active={stepsActive}
        startedAt={startedAt}
        elapsed={elapsed}
      />,
    );
  };

  messages.forEach((message, messageIndex) => {
    message.blocks.forEach((block, blockIndex) => {
      const key = `${message.id}-${block.type}-${blockIndex}`;
      if (block.type !== "text") {
        if (isRenderableStep(block)) pendingSteps.push({ key, block });
        return;
      }
      if (!block.text) return;
      flushSteps();
      content.push(
        <div className="markdown-body" key={key}>
          <Markdown streaming={message.streaming === true}>{block.text}</Markdown>
        </div>,
      );
    });
    const showError = !active && messageIndex === messages.length - 1;
    if (message.error && showError) {
      flushSteps();
      content.push(messageError(message));
    }
  });
  flushSteps();
  return <>{content}</>;
}

export function formatElapsedTime(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

type NonMessageTranscriptItem = Exclude<TranscriptItem, { kind: "message" }>;

const TranscriptItemRow = memo(function TranscriptItemRow({
  item,
}: {
  item: NonMessageTranscriptItem;
}) {
  if (item.kind === "notice") {
    return (
      <div className={`transcript-notice notice-${item.tone}`}>
        <div className="notice-title">
          {item.tone === "error" ? <AlertTriangle size={14} /> : <Check size={14} />}
          {item.title}
        </div>
        <details>
          <summary>Show details</summary>
          <div className="markdown-body">
            <Markdown>{item.text}</Markdown>
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className={`standalone-bash tool-${item.status}`}>
      <div className="standalone-bash-title">
        <TerminalSquare size={15} /> Local bash <span>{item.status}</span>
      </div>
      <pre>
        $ {item.command}
        {item.output ? `\n${item.output}` : ""}
      </pre>
    </div>
  );
});

interface MessageRowProps {
  role: TranscriptMessage["role"];
  messages: readonly TranscriptMessage[];
  tools: Record<string, ToolExecution>;
  active: boolean;
  turnStartedAt?: number;
}

function sameMessageRow(previous: MessageRowProps, next: MessageRowProps): boolean {
  if (
    previous.role !== next.role ||
    previous.active !== next.active ||
    previous.turnStartedAt !== next.turnStartedAt ||
    previous.messages.length !== next.messages.length
  ) {
    return false;
  }
  for (let index = 0; index < previous.messages.length; index++) {
    if (previous.messages[index] !== next.messages[index]) return false;
  }
  if (previous.tools === next.tools) return true;
  for (const message of previous.messages) {
    for (const block of message.blocks) {
      if (
        block.type === "tool_call" &&
        previous.tools[block.toolCallId] !== next.tools[block.toolCallId]
      ) {
        return false;
      }
    }
  }
  return true;
}

const MessageRow = memo(function MessageRow({
  role,
  messages,
  tools,
  active,
  turnStartedAt,
}: MessageRowProps) {
  const messageCompletedAt = messages.findLast(
    (message) => message.completedAt !== undefined,
  )?.completedAt;
  const toolCompletedAt = messages.reduce<number | undefined>((latest, message) => {
    for (const block of message.blocks) {
      if (block.type !== "tool_call") continue;
      const completedAt = tools[block.toolCallId]?.completedAt;
      if (completedAt !== undefined && (latest === undefined || completedAt > latest)) {
        latest = completedAt;
      }
    }
    return latest;
  }, undefined);
  const completedAt = Math.max(messageCompletedAt ?? 0, toolCompletedAt ?? 0) || undefined;
  const elapsed =
    role === "assistant" &&
    !active &&
    turnStartedAt !== undefined &&
    completedAt !== undefined &&
    completedAt >= turnStartedAt
      ? completedAt - turnStartedAt
      : undefined;
  return (
    <article className={`message-row message-${role}`}>
      <div className="message-content">
        {role === "user" ? (
          messages.map((message) => <UserMessageContent key={message.id} message={message} />)
        ) : (
          <AssistantMessagesContent
            messages={messages}
            tools={tools}
            active={active}
            startedAt={turnStartedAt}
            elapsed={elapsed}
          />
        )}
      </div>
    </article>
  );
}, sameMessageRow);

const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 80;
const TRANSCRIPT_INITIAL_ROWS = 16;
const TRANSCRIPT_OVERSCAN_PX = 1_200;

let noticeRowEstimatedHeight: number | undefined;

function estimatedSectionHeight(section: TranscriptSection): number {
  if (section.kind === "item") {
    if (section.item.kind === "notice") {
      noticeRowEstimatedHeight ??= readCssPixelToken("--notice-row-estimated-height");
      return noticeRowEstimatedHeight;
    }
    const lines = Math.max(1, Math.ceil(section.item.output.length / 88));
    return Math.min(460, 82 + lines * 16);
  }

  let lines = 0;
  let steps = 0;
  for (const message of section.messages) {
    for (const block of message.blocks) {
      if (block.type === "text") {
        lines += Math.max(1, Math.ceil(block.text.length / 88));
      } else if (block.type === "image") {
        lines += 10;
      } else if (isRenderableStep(block)) {
        steps += 1;
      }
    }
  }
  return Math.min(1_000, Math.max(72, 38 + lines * 23 + steps * 34));
}

export const TranscriptView = memo(function TranscriptView({
  transcript,
  streamingMessage,
  tools,
  runtime,
}: TranscriptViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const transcriptInner = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const sections = useMemo(
    () => groupTranscriptSections(transcript, streamingMessage),
    [transcript, streamingMessage],
  );
  const virtualizer = useVisibilityObserver(
    scroller,
    transcript.length > TRANSCRIPT_VIRTUALIZE_THRESHOLD,
    TRANSCRIPT_OVERSCAN_PX,
  );
  const lastMessageSection = sections.findLastIndex((section) => section.kind === "messages");
  const activeSection = sections[lastMessageSection];
  const activeSectionHasSteps =
    runtime.isBusy &&
    activeSection?.kind === "messages" &&
    activeSection.role === "assistant" &&
    lastRenderableStepKey(activeSection.messages) !== undefined;
  const activeTurnStartedAt =
    activeSection?.kind === "messages"
      ? activeSection.role === "assistant"
        ? activeSection.turnStartedAt
        : activeSection.messages.at(-1)?.timestamp
      : undefined;
  const unrepresentedRuntimeError = useMemo(
    () =>
      runtime.status === "error" &&
      runtime.lastError &&
      !transcriptRepresentsError(transcript, runtime.lastError.message)
        ? runtime.lastError
        : undefined,
    [runtime.lastError, runtime.status, transcript],
  );
  const showEmptyState =
    sections.length === 0 && !runtime.isBusy && unrepresentedRuntimeError === undefined;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !shouldFollow.current) return;
    element.scrollTop = element.scrollHeight;
  }, [streamingMessage, tools, transcript]);

  const updateScrollState = (element: HTMLDivElement) => {
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    shouldFollow.current = nearBottom;
    setShowJump(!nearBottom);
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    const content = transcriptInner.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (shouldFollow.current) element.scrollTop = element.scrollHeight;
      updateScrollState(element);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    updateScrollState(element);
  };

  const jump = () => {
    const element = scroller.current;
    if (!element) return;
    shouldFollow.current = true;
    setShowJump(false);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <div className="transcript-shell">
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        <div
          className={`transcript-inner${showEmptyState ? " transcript-inner-empty" : ""}`}
          ref={transcriptInner}
        >
          {showEmptyState && (
            <div className="transcript-empty">
              <Sparkles aria-hidden="true" size={22} />
              <strong>Start with a task</strong>
              <span>Describe what you want to build, fix, or understand. Type / for commands.</span>
            </div>
          )}
          {sections.map((section, index) => {
            const key = `${section.kind}-${section.id}`;
            return (
              <VirtualBlock
                className="transcript-virtual-row"
                key={key}
                observer={virtualizer}
                initiallyVisible={index >= sections.length - TRANSCRIPT_INITIAL_ROWS}
                estimatedHeight={estimatedSectionHeight(section)}
              >
                {section.kind === "messages" ? (
                  <MessageRow
                    role={section.role}
                    messages={section.messages}
                    tools={tools}
                    active={
                      section.role === "assistant" &&
                      (section.messages.some((message) => message.streaming === true) ||
                        (runtime.isBusy && index === lastMessageSection))
                    }
                    turnStartedAt={section.turnStartedAt}
                  />
                ) : (
                  <TranscriptItemRow item={section.item} />
                )}
              </VirtualBlock>
            );
          })}
          {unrepresentedRuntimeError && (
            <div className="transcript-notice notice-error runtime-transcript-error" role="alert">
              <div className="notice-title">
                <AlertTriangle size={14} /> {unrepresentedRuntimeError.action}
              </div>
              <p>{unrepresentedRuntimeError.message}</p>
            </div>
          )}
          {runtime.isBusy && !activeSectionHasSteps && (
            <WorkingIndicator startedAt={activeTurnStartedAt} />
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="jump-latest"
          type="button"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={jump}
        >
          <ChevronDown size={18} />
        </button>
      )}
    </div>
  );
});
