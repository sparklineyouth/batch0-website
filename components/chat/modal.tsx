"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Open modals, innermost last: only the top one answers Escape and Tab. */
const stack: string[] = [];

/**
 * A plain modal for chat's forms: portal, dimmed backdrop, Escape and the X
 * close it, Tab stays inside, focus returns to the opener. Same behavior as
 * components/ui/dialog.tsx's ConfirmDialog, with room for a form.
 *
 * Focus starts on the field marked data-autofocus, else the first field, else
 * the dialog itself (so Tab can't wander into the page behind it). A dialog
 * opened on top of another one owns the keyboard until it closes.
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
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      const root = panel.current;
      if (e.key !== "Tab" || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && (at === -1 || at === items.length - 1)) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      // A selector list matches in document order, and the close button comes
      // first — so ask for the marked field before falling back.
      const root = panel.current;
      if (!root || root.contains(document.activeElement)) return;
      (root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>("input, textarea, select") ?? root).focus();
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
  }, [open, id]);

  if (!open || typeof window === "undefined") return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panel}
        tabIndex={-1}
        className={`relative max-h-[76vh] w-full overflow-y-auto rounded-md border border-line bg-paper p-5 shadow-[0_30px_80px_-20px_rgba(20,20,20,0.25)] focus:outline-none ${wide ? "max-w-xl" : "max-w-md"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={`${id}-title`} className="min-w-0 break-words font-display text-2xl leading-none text-ink">
            {title}
          </h2>
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
