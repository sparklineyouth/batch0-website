"use client";
import type {
  PanelOp,
  PanelOpResult,
  PanelPeople,
  PanelRead,
  PanelWrite,
} from "@/lib/webinar-panel";

/**
 * The side panel's calls to /api/live/panel. Plain fetches, not server
 * actions, so nothing here waits in Next's serial action queue behind the
 * engine's heartbeat.
 */

const OFFLINE = { ok: false as const, error: "Couldn't reach the server.", retryInMs: 2_000 };

/** One write. Never throws: a failure comes back as a refusal, marked retryable when it is. */
export async function panelWrite<O extends PanelOp>(
  eventId: string,
  op: O,
): Promise<PanelWrite<PanelOpResult<O["op"]>>> {
  let res: Response;
  try {
    res = await fetch("/api/live/panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventId, ...op }),
      cache: "no-store",
    });
  } catch {
    return OFFLINE;
  }
  if (res.status === 200) {
    try {
      return (await res.json()) as PanelWrite<PanelOpResult<O["op"]>>;
    } catch {
      return OFFLINE;
    }
  }
  if (res.status === 401) return { ok: false, error: "You're signed out — sign in again." };
  if (res.status === 400 || res.status === 403 || res.status === 413) {
    return { ok: false, error: "Couldn't send that." };
  }
  return OFFLINE;
}

/** Who is here (hosts only). Null when there is no answer to draw. */
export async function readPeople(eventId: string): Promise<PanelPeople | null> {
  const q = new URLSearchParams({ event: eventId, parts: "people" });
  const res = await fetch(`/api/live/panel?${q}`, { cache: "no-store" });
  if (res.status !== 200) return null;
  const read = (await res.json()) as PanelRead;
  return read.people ?? null;
}
