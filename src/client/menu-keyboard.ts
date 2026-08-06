import type { KeyboardEvent, RefObject } from "react";

function enabledMenuItems(container: HTMLElement | null): HTMLButtonElement[] {
  return [
    ...(container?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []),
  ];
}

export function shouldCloseMenuOnBlur(
  container: Pick<Node, "contains">,
  relatedTarget: Node | null,
): boolean {
  // Touch browsers can omit relatedTarget when tapping the trigger. The outside-pointer
  // listener still handles genuine taps away from the menu.
  return relatedTarget !== null && !container.contains(relatedTarget);
}

export function handleMenuKeyDown(
  event: KeyboardEvent<HTMLElement>,
  container: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = enabledMenuItems(container.current);
  if (items.length === 0) return;

  event.preventDefault();
  const current = items.findIndex((item) => item === document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current <= 0 ? items.length : current) - 1;
  items[next]?.focus();
}
