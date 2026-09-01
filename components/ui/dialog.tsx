"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X } from "lucide-react";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Scopes the Tab trap to the panel, not the outer wrapper — the wrapper
  // also holds the click-to-dismiss overlay, which must stay out of the cycle.
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the latest onCancel/pending visible to event handlers without
  // putting them in the deps array — otherwise every parent re-render
  // (e.g. on each keystroke in a description input) re-runs the effect
  // and steals focus back to the confirm button.
  const onCancelRef = useRef(onCancel);
  const pendingRef = useRef(pending);
  onCancelRef.current = onCancel;
  pendingRef.current = pending;

  useEffect(() => {
    if (!open) return;
    // Remember the opener so focus goes back to it on close. Without this a
    // keyboard user gets dropped at the top of the document every time they
    // dismiss a confirm. Mirrors components/mobile-nav.tsx.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pendingRef.current) {
        onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab inside the panel. `select`/`textarea` are in the selector
      // because admin dialogs pass form controls through `description`, and
      // `:disabled` is excluded so the `pending` state (which disables every
      // button here) can't leave the cycle pointing at unfocusable elements.
      const root = panelRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a, button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Move focus to the confirm button when the dialog opens, but only
    // once per open transition. Re-running on every parent render would
    // yank focus away from inputs inside the dialog (e.g. textareas in
    // `description`) on each keystroke.
    confirmRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || typeof window === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close"
        // tabIndex={-1}: this is a full-viewport click target, so leaving it
        // in the tab order gives every dialog a phantom stop covering the
        // whole screen. The X button below is the keyboard-reachable close.
        tabIndex={-1}
        onClick={() => !pending && onCancel()}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        className="relative w-full max-w-md rounded-2xl border border-line bg-paper p-6 shadow-[0_30px_80px_-20px_rgba(20,20,20,0.25)]"
      >
        <button
          type="button"
          aria-label="Close"
          disabled={pending}
          onClick={onCancel}
          className="absolute right-4 top-4 text-ink-faint hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          {destructive && (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-300">
              <AlertTriangle className="h-5 w-5" />
            </div>
          )}
          <div className="flex-1">
            <h2
              id="confirm-dialog-title"
              className="font-display text-lg font-semibold tracking-[-0.02em] text-ink"
            >
              {title}
            </h2>
            {description && (
              <div className="mt-2 text-sm text-ink-soft">{description}</div>
            )}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
