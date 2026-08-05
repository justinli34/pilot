import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

interface SidebarResizeOptions {
  width: number;
  resizeStep: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onToggleCollapsed: () => void;
}

export function useSidebarResize(options: SidebarResizeOptions) {
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = options.width;
    let pendingWidth = startWidth;
    let dragging = false;
    let frame: number | undefined;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!dragging && Math.abs(delta) <= 3) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add("resizing-sidebar");
      }
      pendingWidth = startWidth + delta;
      if (frame === undefined) {
        frame = window.requestAnimationFrame(() => {
          frame = undefined;
          options.onResize(pendingWidth);
        });
      }
    };
    const finish = (finishEvent: PointerEvent) => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (dragging) {
        options.onResize(pendingWidth);
        options.onResizeEnd(pendingWidth);
      } else if (finishEvent.type === "pointerup") {
        options.onToggleCollapsed();
      }
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      options.onToggleCollapsed();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next =
      options.width + (event.key === "ArrowRight" ? options.resizeStep : -options.resizeStep);
    options.onResize(next);
    options.onResizeEnd(next);
  };

  return { beginResize, resizeWithKeyboard };
}
