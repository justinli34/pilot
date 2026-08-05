import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

type VisibilityListener = (visible: boolean) => void;

export interface VisibilityObserver {
  register: (element: HTMLDivElement, listener: VisibilityListener) => () => void;
}

export function useVisibilityObserver(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  overscanPx: number,
): VisibilityObserver | undefined {
  const listeners = useRef(new Map<Element, VisibilityListener>());
  const observer = useRef<IntersectionObserver | undefined>(undefined);

  const register = useCallback((element: HTMLDivElement, listener: VisibilityListener) => {
    listeners.current.set(element, listener);
    if (observer.current) observer.current.observe(element);
    else if (typeof IntersectionObserver === "undefined") listener(true);
    return () => {
      observer.current?.unobserve(element);
      listeners.current.delete(element);
    };
  }, []);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (typeof IntersectionObserver === "undefined") {
      for (const listener of listeners.current.values()) listener(true);
      return;
    }
    const next = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) listeners.current.get(entry.target)?.(entry.isIntersecting);
      },
      { root: root.current, rootMargin: `${overscanPx}px 0px` },
    );
    observer.current = next;
    for (const element of listeners.current.keys()) next.observe(element);
    return () => {
      next.disconnect();
      if (observer.current === next) observer.current = undefined;
    };
  }, [enabled, overscanPx, root]);

  return useMemo(() => (enabled ? { register } : undefined), [enabled, register]);
}

interface VirtualBlockProps {
  observer: VisibilityObserver | undefined;
  initiallyVisible?: boolean;
  estimatedHeight: CSSProperties["height"];
  className: string;
  children: ReactNode;
}

export function VirtualBlock({
  observer,
  initiallyVisible = true,
  estimatedHeight,
  className,
  children,
}: VirtualBlockProps) {
  const element = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(observer === undefined || initiallyVisible);
  const [visible, setVisible] = useState(visibleRef.current);
  const [placeholderHeight, setPlaceholderHeight] = useState(estimatedHeight);
  visibleRef.current = visible;

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (!observer) {
      visibleRef.current = true;
      setVisible(true);
      return;
    }
    return observer.register(node, (nearViewport) => {
      if (!nearViewport && visibleRef.current) {
        const measured = Math.ceil(node.getBoundingClientRect().height);
        if (measured > 0) setPlaceholderHeight(measured);
      }
      visibleRef.current = nearViewport;
      setVisible((current) => (current === nearViewport ? current : nearViewport));
    });
  }, [observer]);

  return (
    <div
      className={className}
      ref={element}
      style={visible ? undefined : { height: placeholderHeight }}
      aria-hidden={visible ? undefined : true}
    >
      {visible ? children : null}
    </div>
  );
}
