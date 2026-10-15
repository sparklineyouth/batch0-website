"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { REACTION_EMOJI } from "@/lib/chat-access";

const ITEM = '[role^="menuitem"]:not(:disabled)';

/**
 * A small anchored panel that closes on an outside click, Escape, or focus
 * leaving it. Escape is captured and marked handled, so a dialog or the
 * composer underneath doesn't also act on it.
 *
 * "Outside" means outside the popover's wrapper, which also holds its toggle:
 * a press on the toggle is the toggle's to handle. Closing on its mousedown
 * would let the click that follows open it straight back up.
 *
 * A menu inside it behaves like one: focus moves to its first item on open,
 * ↑/↓/Home/End move between items, and Escape or a pick hands focus back to
 * the toggle (so a dialog the pick opens returns focus there when it closes).
 * It opens upward when there isn't room below it — the newest messages sit
 * right above the composer.
 */
export function Popover({
  open,
  onClose,
  children,
  className = "",
  toggleRef,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** The button that opens it. */
  toggleRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [up, setUp] = useState(false);

  const backToToggle = () => toggleRef?.current?.focus({ preventScroll: true });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const anchor = ref.current?.parentElement ?? ref.current;
      if (anchor && !anchor.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (ref.current?.contains(document.activeElement)) backToToggle();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Room below, or open upward; then focus the first item.
  useLayoutEffect(() => {
    if (!open) {
      setUp(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden") {
        const r = p.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
        break;
      }
    }
    const anchor = el.parentElement?.getBoundingClientRect();
    if (rect.bottom > bottom && anchor && anchor.top - top > bottom - anchor.bottom) setUp(true);
    const first = el.querySelector<HTMLElement>(`${ITEM}, [data-autofocus], button:not(:disabled):not([tabindex="-1"])`);
    first?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      style={up ? { top: "auto", bottom: "calc(100% + 4px)" } : undefined}
      className={`absolute z-30 rounded-md border border-line bg-paper p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] ${className}`}
      onClickCapture={(e) => {
        // A pick: focus goes back to the toggle before the item acts, so a
        // dialog it opens remembers the toggle as the place to return to.
        if ((e.target as HTMLElement).closest('[role^="menuitem"]')) backToToggle();
      }}
      onKeyDown={(e) => {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (at === -1 || items.length === 0) return;
        const go = (i: number) => {
          e.preventDefault();
          items[(i + items.length) % items.length].focus();
        };
        if (e.key === "ArrowDown") go(at + 1);
        else if (e.key === "ArrowUp") go(at - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(items.length - 1);
      }}
      onBlur={(e) => {
        // Tab out of a menu closes it.
        const anchor = ref.current?.parentElement ?? ref.current;
        const next = e.relatedTarget as Node | null;
        if (next && anchor && !anchor.contains(next)) closeRef.current();
      }}
    >
      {children}
    </div>
  );
}

const COLUMNS = 8;

/**
 * The reaction palette: exactly what the server accepts. One Tab stop; the
 * arrow keys move around the grid.
 */
export function EmojiGrid({ onPick, label = "Add a reaction" }: { onPick: (emoji: string) => void; label?: string }) {
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const move = (i: number) => {
    const next = Math.max(0, Math.min(REACTION_EMOJI.length - 1, i));
    setAt(next);
    ref.current?.querySelectorAll<HTMLElement>("button")[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className="grid w-[17rem] grid-cols-8 gap-0.5 p-1"
      onKeyDown={(e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS } as Record<string, number>;
        if (d[e.key] !== undefined) {
          e.preventDefault();
          move(at + d[e.key]);
        } else if (e.key === "Home") {
          e.preventDefault();
          move(0);
        } else if (e.key === "End") {
          e.preventDefault();
          move(REACTION_EMOJI.length - 1);
        }
      }}
    >
      {REACTION_EMOJI.map((e, i) => (
        <button
          key={e}
          type="button"
          tabIndex={i === at ? 0 : -1}
          onFocus={() => setAt(i)}
          onClick={() => onPick(e)}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-wash focus-visible:bg-wash"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** A menu row. `checked` makes it one of a set of choices (menuitemradio). */
export function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger = false,
  disabled = false,
  checked,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}) {
  const radio = checked !== undefined;
  return (
    <button
      type="button"
      role={radio ? "menuitemradio" : "menuitem"}
      aria-checked={radio ? checked : undefined}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm focus:outline-none disabled:opacity-50 ${
        danger ? "text-red-600 hover:bg-red-500/10 focus:bg-red-500/10 dark:text-red-400" : "text-ink hover:bg-wash focus:bg-wash"
      }`}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {radio && checked ? <span aria-hidden className="shrink-0 text-ink-faint">✓</span> : null}
    </button>
  );
}

/** A line between groups of menu items. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
