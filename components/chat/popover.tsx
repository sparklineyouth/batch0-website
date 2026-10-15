"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { REACTION_EMOJI } from "@/lib/chat-access";

/**
 * A small anchored panel that closes on an outside click or Escape. Escape
 * is captured and marked handled, so a dialog or the composer underneath
 * doesn't also act on it.
 */
export function Popover({
  open,
  onClose,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`absolute z-30 rounded-md border border-line bg-paper p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] ${className}`}
    >
      {children}
    </div>
  );
}

/** The reaction palette: exactly what the server accepts. */
export function EmojiGrid({ onPick, label = "Add a reaction" }: { onPick: (emoji: string) => void; label?: string }) {
  return (
    <div role="listbox" aria-label={label} className="grid w-[17rem] grid-cols-8 gap-0.5 p-1">
      {REACTION_EMOJI.map((e) => (
        <button
          key={e}
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => onPick(e)}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-wash"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** A menu row. */
export function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm disabled:opacity-50 ${
        danger ? "text-red-600 hover:bg-red-500/10 dark:text-red-400" : "text-ink hover:bg-wash"
      }`}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
