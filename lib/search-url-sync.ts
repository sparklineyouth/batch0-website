/**
 * A search-as-you-type box that writes `?q=` and reads it back — when may the
 * page's query replace what is in the box? Pure, so `node --test` runs it
 * (lib/search-url-sync.test.ts). Used by the Resources search
 * (app/dashboard/resources/resource-search.tsx) and the Support queue's
 * (app/admin/support/support-search.tsx).
 *
 * The box navigates after each pause in typing, and the page re-renders with
 * the query it was asked for. The box must follow the URL when something
 * else moved it (Back, a "Clear" link) — or it keeps saying "pitch" over a
 * list that isn't filtered — but never because its own navigation came back.
 * The boxes used to tell the two apart by comparing the page's query with the
 * one they asked for last. That holds until two are in flight: type "pi",
 * pause, type "tch", pause, and if the "pi" render lands after "pitch" was
 * sent, it reads as the URL moving under the box and overwrites what the
 * person is typing with "pi" (and then, a moment later, with "pitch").
 *
 * So the box remembers every query it has asked for that hasn't come back
 * yet. A render of one of those is its own echo: ignored, along with anything
 * asked before it (renders land in the order they were asked, some skipped,
 * so a render can't be older than one already in). Only a query it never
 * asked for is the URL moving, and is followed.
 *
 * A query can be in flight twice — "pi", "pitch", then back to "pi". A "pi"
 * render is then matched with the OLDER "pi": renders land in ask order, so
 * it's the first that's due. Matched with the newer one, a late first "pi"
 * cleared "pitch" from the list too, and when that render came in it read as
 * the URL moving and overwrote the box twice over. Matching the older one can
 * leave an ask in the list that was skipped (only the newest "pi" rendered);
 * the next ask that renders clears it.
 */

/** Enough for any burst of typing; older asks than this are long settled. */
const ASKED_MAX = 20;

export type QuerySync = {
  /** The query the URL holds as far as the box knows: its newest ask, or the page's last render. */
  shown: string;
  /** Queries the box navigated to whose render hasn't arrived, oldest first. */
  asked: readonly string[];
};

/** The box as the page first rendered it. */
export function startQuerySync(initial: string): QuerySync {
  return { shown: initial, asked: [] };
}

/**
 * The box navigated to `q`. Asking for the query it already shows (a shelf
 * picked, Enter pressed) changes nothing the box waits on: that render
 * either doesn't change the page's query at all, or is the one already
 * awaited.
 */
export function askedFor(sync: QuerySync, q: string): QuerySync {
  if (q === sync.shown) return sync;
  return { shown: q, asked: [...sync.asked, q].slice(-ASKED_MAX) };
}

/**
 * The page rendered with `pageQuery` (the `initialQuery` prop changed). Says
 * whether the box should now show it (`follow`) and what to remember.
 */
export function pageRendered(sync: QuerySync, pageQuery: string): { sync: QuerySync; follow: boolean } {
  // The oldest occurrence: the one due first (see the note at the top).
  const i = sync.asked.indexOf(pageQuery);
  // One of ours: the newest landing (nothing left in flight), or an older
  // one arriving late, after the box had already asked for something newer.
  if (i >= 0) return { sync: { shown: sync.shown, asked: sync.asked.slice(i + 1) }, follow: false };
  if (pageQuery === sync.shown) return { sync, follow: false };
  // Something else moved the URL: Back, or a "Clear" link.
  return { sync: { shown: pageQuery, asked: [] }, follow: true };
}
