import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

const MIN_SWIPE_DISTANCE = 48;
const HORIZONTAL_DIRECTION_RATIO = 1.25;
const DIRECTION_LOCK_DISTANCE = 8;

export type SidebarSwipeDirection = "left" | "right";

export function detectSidebarSwipe(
  deltaX: number,
  deltaY: number,
): SidebarSwipeDirection | undefined {
  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance < MIN_SWIPE_DISTANCE ||
    horizontalDistance < Math.abs(deltaY) * HORIZONTAL_DIRECTION_RATIO
  ) {
    return undefined;
  }
  return deltaX > 0 ? "right" : "left";
}

interface SidebarSwipeOptions {
  enabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

interface ActiveSwipe {
  pointerId: number;
  startX: number;
  startY: number;
  startedOpen: boolean;
}

type AppPointerEvent = ReactPointerEvent<HTMLDivElement>;

function canStartSwipe(target: EventTarget, open: boolean): boolean {
  if (!(target instanceof Element)) return false;
  const selector = open
    ? "#pilot-navigation, .mobile-sidebar-backdrop"
    : "[data-sidebar-swipe-edge]";
  return target.closest(selector) !== null;
}

export function useSidebarSwipe(options: SidebarSwipeOptions) {
  const { enabled, open, onOpen, onClose } = options;
  const activeSwipe = useRef<ActiveSwipe | undefined>(undefined);

  const onPointerDown = useCallback(
    (event: AppPointerEvent) => {
      if (
        !enabled ||
        !event.isPrimary ||
        event.pointerType === "mouse" ||
        activeSwipe.current ||
        !canStartSwipe(event.target, open)
      ) {
        return;
      }
      activeSwipe.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedOpen: open,
      };
    },
    [enabled, open],
  );

  const onPointerMove = useCallback((event: AppPointerEvent) => {
    const swipe = activeSwipe.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    const movingInExpectedDirection = swipe.startedOpen ? deltaX < 0 : deltaX > 0;
    if (
      movingInExpectedDirection &&
      Math.abs(deltaX) >= DIRECTION_LOCK_DISTANCE &&
      Math.abs(deltaX) > Math.abs(deltaY)
    ) {
      event.preventDefault();
    }
  }, []);

  const onPointerUp = useCallback(
    (event: AppPointerEvent) => {
      const swipe = activeSwipe.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      activeSwipe.current = undefined;
      const direction = detectSidebarSwipe(
        event.clientX - swipe.startX,
        event.clientY - swipe.startY,
      );
      if (
        (!swipe.startedOpen && direction === "right") ||
        (swipe.startedOpen && direction === "left")
      ) {
        event.preventDefault();
        if (swipe.startedOpen) onClose();
        else onOpen();
      }
    },
    [onClose, onOpen],
  );

  const onPointerCancel = useCallback((event: AppPointerEvent) => {
    if (activeSwipe.current?.pointerId === event.pointerId) activeSwipe.current = undefined;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
