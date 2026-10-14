"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { LocalMediaView } from "../types";
import { FOCUS } from "../ui";
import { DeviceControls } from "./device-controls";
import { SelfPreview } from "./self-preview";

/**
 * Audio & video settings during a call: a modal sheet (bottom sheet on
 * phones). Same controls as the green room.
 */
export function DevicePanel({
  open,
  onClose,
  media,
  name,
}: {
  open: boolean;
  onClose: () => void;
  media: LocalMediaView | null;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>("button, select")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && ref.current) {
        // Keep focus inside the dialog.
        const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled])")];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      (returnTo.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-[rgba(0,0,0,0.6)] font-sans sm:items-center sm:p-6"
      style={{ colorScheme: "dark" }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Audio and video settings"
        data-testid="device-panel"
        className="max-h-[90dvh] w-full overflow-y-auto rounded-t-md border border-[#34343a] bg-[#141416] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-[#f4f4f5] sm:max-w-md sm:rounded-md sm:p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-medium">Audio &amp; video</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={`rounded p-1.5 text-[#a1a1aa] hover:bg-[#26262b] hover:text-[#fff] ${FOCUS}`}
            data-testid="device-panel-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {media ? (
          <SelfPreview media={media} name={name} className="mb-4" />
        ) : null}
        <DeviceControls media={media} />
      </div>
    </div>,
    document.body,
  );
}
