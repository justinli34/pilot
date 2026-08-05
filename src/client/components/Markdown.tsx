import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";

interface MarkdownProps {
  children: string;
  streaming?: boolean;
}

const STREAMING_MARKDOWN_INTERVAL_MS = 120;
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.js"));

function useStreamingMarkdown(value: string, streaming: boolean): string {
  const [rendered, setRendered] = useState(value);
  const latest = useRef(value);
  const lastRenderedAt = useRef(performance.now());
  const timer = useRef<number | undefined>(undefined);
  latest.current = value;

  useEffect(() => {
    if (!streaming) {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      lastRenderedAt.current = performance.now();
      setRendered(value);
      return;
    }

    const remaining = STREAMING_MARKDOWN_INTERVAL_MS - (performance.now() - lastRenderedAt.current);
    if (remaining <= 0) {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      lastRenderedAt.current = performance.now();
      setRendered(value);
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      lastRenderedAt.current = performance.now();
      setRendered(latest.current);
    }, remaining);
  }, [streaming, value]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  return streaming ? rendered : value;
}

export const Markdown = memo(function Markdown({ children, streaming = false }: MarkdownProps) {
  const rendered = useStreamingMarkdown(children, streaming);
  return (
    <Suspense fallback={<span className="markdown-loading">{rendered}</span>}>
      <MarkdownRenderer streaming={streaming}>{rendered}</MarkdownRenderer>
    </Suspense>
  );
});
