"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * A plain modal for chat's forms: portal, dimmed backdrop, Escape and the X
 * close it, Tab stays inside, focus returns to the opener. Same behavior as
 * components/ui/dialog.tsx's ConfirmDialog, with room for a form.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
  busy = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = panel.current.querySelectorAll<HTMLElement>(
        'a, button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      // A selector list matches in document order, and the close button comes
      // first — so ask for the marked field before falling back.
      const root = panel.current;
      (root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>("input, textarea, select"))?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open || typeof window === "undefined") return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panel}
        className={`relative max-h-[76vh] w-full overflow-y-auto rounded-md border border-line bg-paper p-5 shadow-[0_30px_80px_-20px_rgba(20,20,20,0.25)] ${wide ? "max-w-xl" : "max-w-md"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-2xl leading-none text-ink">{title}</h2>
          <button type="button" aria-label="Close" disabled={busy} onClick={onClose} className="rounded p-1 text-ink-faint hover:bg-wash hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
