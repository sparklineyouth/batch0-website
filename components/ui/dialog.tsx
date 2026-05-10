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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKey);
    confirmRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onCancel, pending]);

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
        onClick={() => !pending && onCancel()}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
        <button
          type="button"
          aria-label="Close"
          disabled={pending}
          onClick={onCancel}
          className="absolute right-4 top-4 text-white/40 hover:text-white"
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
              className="text-lg font-semibold text-white"
            >
              {title}
            </h2>
            {description && (
              <div className="mt-2 text-sm text-white/60">{description}</div>
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
