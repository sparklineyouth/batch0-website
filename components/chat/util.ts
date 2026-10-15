import type { ActionResult } from "@/lib/action-result";

/** The message an ActionResult failed with, or the fallback. */
export function resultError(res: ActionResult<unknown> | { ok: false; error: string }, fallback: string): string {
  return !res.ok && res.error ? res.error : fallback;
}

/**
 * Is this keystroke part of an IME composition (Japanese, Chinese, Korean…)?
 * Safari fires the Enter that commits a conversion AFTER compositionend, with
 * isComposing false and keyCode 229 — so check both, or that Enter sends.
 */
export function imeComposing(e: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** "3:04 PM" in the viewer's locale. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday", or "Monday, October 12, 2026". */
export function dayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/** "Today at 3:04 PM" / "10/12/2026 3:04 PM" — a message header's timestamp. */
export function stampLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === d.toDateString();
  const time = clockTime(iso);
  if (sameDay) return `Today at ${time}`;
  if (yesterday) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}
