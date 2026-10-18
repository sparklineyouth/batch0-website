/**
 * The browser's half of the draft route (app/api/assignments/[id]/draft):
 * what components/assignments/submit-form.tsx calls to save and to re-read a
 * draft. No imports beyond the pure rules, so `node --test` runs it with a
 * stand-in fetch (lib/assignment-drafts-client.test.ts).
 */
import {
  parseDraftSaveResponse,
  parseDraftStateResponse,
  type DraftSaveResult,
  type DraftState,
} from "./assignment-drafts.ts";

export type DraftSaveInput = {
  assignmentId: string;
  body: string | null;
  linkUrl: string | null;
  /** The draft version this text was typed on top of (0: none yet). */
  baseVersion: number;
};

/**
 * A keepalive request's body has to fit the browser's 64 KiB budget (shared
 * by every keepalive request in flight). A full 10,000-character answer is
 * ~30 KB at worst; anything bigger goes as an ordinary request.
 */
export const KEEPALIVE_MAX_BYTES = 60_000;

export function draftEndpoint(assignmentId: string): string {
  return `/api/assignments/${encodeURIComponent(assignmentId)}/draft`;
}

/**
 * Save a draft. Always a keepalive request when it fits: one sent as the tab
 * closes, the phone locks or the student navigates away is then finished by
 * the browser after the page is gone — an ordinary fetch (which is all a
 * server action is) is cancelled with the page, and the text typed in the
 * last couple of seconds with it.
 *
 * `fetch` is called synchronously, before any await, so a save started from
 * `pagehide` or `beforeunload` is on the wire before the handler returns.
 * A network failure rejects (the form treats that as retryable); everything
 * the server says comes back as a result.
 */
export function saveDraftOverHttp(input: DraftSaveInput, fetchImpl: typeof fetch = fetch): Promise<DraftSaveResult> {
  const payload = JSON.stringify({ body: input.body, linkUrl: input.linkUrl, baseVersion: input.baseVersion });
  const request = fetchImpl(draftEndpoint(input.assignmentId), {
    method: "POST",
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    keepalive: new TextEncoder().encode(payload).length <= KEEPALIVE_MAX_BYTES,
  });
  return request.then(async (res) => parseDraftSaveResponse(res.status, await res.json().catch(() => null)));
}

/** The draft and submission as they stand now, or null when that couldn't be read. */
export async function loadDraftOverHttp(
  assignmentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DraftState | null> {
  try {
    const res = await fetchImpl(draftEndpoint(assignmentId), {
      credentials: "same-origin",
      cache: "no-store",
    });
    return parseDraftStateResponse(res.status, await res.json().catch(() => null));
  } catch {
    return null;
  }
}
