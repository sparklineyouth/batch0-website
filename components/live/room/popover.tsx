"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/**
 * Small menus anchored to control-bar buttons. One open at a time across the
 * room (the coordinator below). They render in a portal above the room and
 * open upwards from their button, so the bar itself never reflows.
 */

type Coordinator = { openId: string | null; setOpenId: (id: string | null) => void };
const PopoverContext = createContext<Coordinator | null>(null);

export function PopoverProvider({
  children,
  onOpen,
}: {
  children: ReactNode;
  /** Called whenever a popover opens (the room closes a mobile sheet). */
  onOpen?: (id: string) => void;
}) {
  const [openId, setOpen] = useState<string | null>(null);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  const setOpenId = useCallback((id: string | null) => {
    setOpen(id);
    if (id) onOpenRef.current?.(id);
  }, []);
  const value = useMemo(() => ({ openId, setOpenId }), [openId, setOpenId]);
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

/** Open state for one popover id. Works without a provider (local state). */
export function usePopover(id: string) {
  const ctx = useContext(PopoverContext);
  const [local, setLocal] = useState(false);
  const open = ctx ? ctx.openId === id : local;
  const setOpen = useCallback(
    (next: boolean) => {
      if (ctx) {
        if (next) ctx.setOpenId(id);
        else if (ctx.openId === id) ctx.setOpenId(null);
      } else setLocal(next);
    },
    [ctx, id],
  );
  return { open, setOpen, toggle: () => setOpen(!open) };
}

/** Close every popover (e.g. when a panel opens). */
export function useCloseAllPopovers() {
  const ctx = useContext(PopoverContext);
  return useCallback(() => ctx?.setOpenId(null), [ctx]);
}

const GAP = 8;
const EDGE = 8;

export function Popover({
  anchor,
  open,
  onClose,
  label,
  role = "menu",
  align = "center",
  children,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  role?: "menu" | "dialog";
  align?: "start" | "center" | "end";
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    const el = ref.current;
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth;
    const vw = window.innerWidth;
    let left =
      align === "start" ? r.left : align === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    setPos({ left, bottom: window.innerHeight - r.top + GAP });
  }, [anchor, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    window.addEventListener("resize", place);
    // Content can change size (a confirm step); keep it anchored.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (ref.current) ro?.observe(ref.current);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [open, place]);

  // The latest onClose, so the effect below runs once per opening (re-running
  // it would pull focus back to the first item on every parent render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus the first item; Esc and outside presses close.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(
      "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        anchor.current?.focus({ preventScroll: true });
        return;
      }
      // Arrow keys move between menu items.
      if (role === "menu" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : e.key === "ArrowDown"
                ? (i + 1) % items.length
                : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, anchor, role]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-testid={testId}
      style={{
        left: pos?.left ?? -9999,
        bottom: pos?.bottom ?? 0,
        visibility: pos ? "visible" : "hidden",
        colorScheme: "dark",
      }}
      className="fixed z-[75] max-h-[min(70vh,520px)] w-max min-w-[220px] max-w-[min(92vw,360px)] overflow-y-auto rounded-md border border-[#34343a] bg-[#1b1b1f] p-1.5 font-sans text-sm text-[#f4f4f5] shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
    >
      {children}
    </div>,
    document.body,
  );
}

/** One row in a popover menu. */
export function MenuItem({
  icon,
  children,
  onClick,
  tone = "default",
  disabled,
  testId,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  testId?: string;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`flex w-full items-center gap-3 rounded px-3 py-2.5 text-left text-sm transition-colors focus-visible:bg-[#2a2a30] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === "danger"
          ? "text-[#ff8a8d] hover:bg-[#3a1d1f]"
          : "text-[#f4f4f5] hover:bg-[#2a2a30]"
      }`}
    >
      {icon ? <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint ? <span className="block truncate text-xs text-[#a1a1aa]">{hint}</span> : null}
      </span>
    </button>
  );
}
