import type { ActionResult } from "@/lib/action-result";

/** What a write says when it never reached the server (offline, or a deploy swapped the actions out). */
export const OFFLINE = "Couldn't reach batch0. Check your connection and try again.";

/** Who a message is from once the account behind it is gone. */
export const DELETED_NAME = "Deleted account";

/** A person's name, "Deleted account" for a sender with no account left, "batch0" for system lines. */
export function senderName(
  m: { senderId: string | null; kind?: "message" | "system" },
  people: Record<string, { name: string }>,
): string {
  if (!m.senderId) return m.kind === "system" ? "batch0" : DELETED_NAME;
  return people[m.senderId]?.name ?? DELETED_NAME;
}

/**
 * The id for a message being written: made once, when it's sent from the
 * composer, and kept by every Retry of it (0104). A random v4 uuid — the
 * server keys a sender's messages by it, so it must never repeat.
 */
export function newClientId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older browsers, or a page served without a secure context.
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The message an ActionResult failed with, or the fallback. */
export function resultError(res: ActionResult<unknown> | { ok: false; error: string }, fallback: string): string {
  return !res.ok && res.error ? res.error : fallback;
}

/**
 * Does Enter send? Not on a touch keyboard: it has no Shift+Enter, so Enter
 * is the only way to start a new line there, and the Send button sends.
 */
export function enterSends(): boolean {
  return typeof window === "undefined" || !window.matchMedia("(hover: none) and (pointer: coarse)").matches;
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

/**
 * The next page of "report a deleted message" under the ones already shown:
 * in order, each once. A message deleted between two pages has moved to the
 * top of the server's order, so it never comes back twice; this only makes
 * sure of it.
 */
export function appendStubs<T extends { id: string }>(shown: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(shown.map((m) => m.id));
  const out = [...shown];
  for (const m of page) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
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

/** "just now", "5m", "3h", "2d", "Oct 3": how long ago, for a thread's last reply. */
export function sinceLabel(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
