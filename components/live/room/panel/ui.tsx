"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { SendHorizontal } from "lucide-react";

/**
 * Field colours. The `dark:` copies outrank the app's `.theme-light input`
 * compatibility rule, which would otherwise paint fields white on the dark
 * call surface.
 */
export const FIELD =
  "border-line bg-paper text-ink dark:border-line dark:bg-paper dark:text-ink";

/** A small icon action on a row: always labelled, visible on hover, focus and touch. */
export function RowAction({
  label,
  onClick,
  children,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition hover:bg-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
        tone === "danger" ? "hover:text-red-500" : "hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Row actions sit hidden until the row is hovered or focused; always shown on touch. */
export const ROW_ACTIONS =
  "flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

export function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium ${
        tone === "accent" ? "bg-phosphor/20 text-phosphor-ink" : "bg-ink/10 text-ink-soft"
      }`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-xs text-ink-faint">{children}</p>;
}

/**
 * The composer: Enter sends, Shift+Enter is a newline, never disabled while a
 * send is in flight (the outbox shows it), grows to four lines.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  canSubmit,
  placeholder,
  label,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  placeholder: string;
  label: string;
  maxLength: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [value]);
  return (
    <form
      className="flex items-end gap-2 border-t border-line p-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        aria-label={label}
        className={`max-h-24 min-h-9 flex-1 resize-none rounded-md border px-3 py-2 text-base placeholder:text-ink-faint focus:border-phosphor focus:outline-none md:text-sm ${FIELD}`}
      />
      <button
        type="submit"
        disabled={!canSubmit}
        aria-label="Send"
        title="Send"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-phosphor text-on-phosphor transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        <SendHorizontal className="h-4 w-4" />
      </button>
    </form>
  );
}

/** A closed composer's one line. */
export function Closed({ children }: { children: ReactNode }) {
  return <p className="border-t border-line p-3 text-center text-xs text-ink-faint">{children}</p>;
}
