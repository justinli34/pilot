import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalDialogProps {
  backdropClassName: string;
  dialogClassName: string;
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ModalDialog({
  backdropClassName,
  dialogClassName,
  role = "dialog",
  labelledBy,
  describedBy,
  closeDisabled = false,
  onClose,
  children,
}: ModalDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const appRoot = document.getElementById("root");
    const appWasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;

    return () => {
      if (appRoot) appRoot.inert = appWasInert;
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !closeDisabled) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), [contenteditable='true'], [tabindex]:not([tabindex='-1'])",
      ) ?? []),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) event.preventDefault();
    else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className={backdropClassName}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        className={dialogClassName}
        ref={dialog}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
