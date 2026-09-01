import Link from "next/link";
import { Search } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import {
  AppHeader,
  AppBody,
  Empty,
  Row,
  ActionLink,
} from "@/components/app/frame";

export const metadata = { title: "People · Admin" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/**
 * Look someone up.
 *
 * This is the admin thing most worth having in a pocket: a student messages you,
 * or you're standing in a room with one, and you need to know where they are —
 * enrolled or not, paid or not, checked in or drifting.
 *
 * The search is a plain GET form, not a controlled input with a debounce. It
 * costs no client JavaScript, it survives a cold start, the browser remembers
 * the query on back-navigation, and the phone keyboard shows a real "Search"
 * key. Every one of those is a better outcome than as-you-type on a spotty
 * connection.
 *
 * Paging is a cursor in the query string, for the same reasons. This screen
 * used to stop dead at 40 rows and tell the admin to go finish the job on the
 * desktop directory — which on a phone means a sideways-scrolling grid with an
 * inline role editor in a 32px track. Past a program's first cohort that made
 * the in-app directory structurally incomplete, so the whole list is reachable
 * here now and the escape hatch is gone.
 */
export default async function AdminAppPeople({
  searchParams,
}: {
  searchParams: { q?: string; before?: string };
}) {
  await requirePermission("people.view");
  const admin = createAdminClient();
  const q = (searchParams.q ?? "").trim();
  const before = searchParams.before;

  // Keyset, not `.range()`: the list is newest-first and grows at the head, so
  // an offset shifts under the reader every time someone signs up mid-scroll.
  // The one known seam is that `created_at` is not unique — two profiles
  // written in the same millisecond straddle a page boundary and the second is
  // skipped. Live signups are seconds apart; a bulk import is not, so if one
  // ever lands here this wants a composite (created_at, id) cursor.
  let query = admin
    .from("profiles")
    .select("id, full_name, email, role, created_at")
    .order("created_at", { ascending: false })
    // One more than a page: the extra row is how we know there IS a next page
    // without a second count query. It is sliced off before rendering.
    .limit(PAGE_SIZE + 1);
  if (before) query = query.lt("created_at", before);
  if (q) {
    // Escaped for PostgREST's `or` grammar: a comma or a parenthesis in the
    // query string would otherwise be read as filter syntax and either widen
    // the search or 400 the request.
    const safe = q.replace(/[,()]/g, " ");
    query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`);
  }
  const { data: fetched } = await query;
  const hasOlder = (fetched ?? []).length > PAGE_SIZE;
  const people = (fetched ?? []).slice(0, PAGE_SIZE);

  // Application status for exactly the rows on screen — one query for the page.
  // Keyed off the SLICED rows, so the probe row never drags a 41st application
  // along with it.
  const ids = people.map((p) => p.id as string);
  const { data: apps } = ids.length
    ? await admin
        .from("applications")
        .select("user_id, status, created_at")
        .in("user_id", ids)
        .order("created_at", { ascending: false })
    : { data: null };
  // First row per user wins — the query is newest-first, so this is the latest
  // application without a second round trip.
  const statusByUser = new Map<string, string>();
  for (const a of apps ?? []) {
    const uid = a.user_id as string;
    if (!statusByUser.has(uid)) statusByUser.set(uid, a.status as string);
  }

  // Both are plain GET links, matching the search form: no client JavaScript,
  // and the browser's own history is the "back a page" control.
  const last = people[people.length - 1];
  const older =
    hasOlder && last
      ? `/app/admin/people?${new URLSearchParams({
          ...(q ? { q } : {}),
          before: last.created_at as string,
        })}`
      : null;
  // Without this a deep cursor is a one-way trip on any reload — the query
  // string survives, so "scroll up" does not get you back to the newest rows.
  const newest = !before
    ? null
    : q
      ? `/app/admin/people?q=${encodeURIComponent(q)}`
      : "/app/admin/people";

  return (
    <>
      <AppHeader
        title="People"
        eyebrow={q ? `“${q}”` : before ? "Older signups" : "Students and staff"}
      />
      <AppBody>
        <form action="/app/admin/people" method="get" className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name or email"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            // 16px, not 15: iOS Safari auto-zooms the whole page when a focused
            // input's text is under 16px, and the zoom does not undo itself on
            // blur. globals.css sets text-size-adjust for the same reason, but
            // that does not cover focus zoom — only the font size does.
            className="h-12 w-full rounded-xl border border-line bg-wash pl-11 pr-4 text-[16px] text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
          />
        </form>

        <div className="mt-5">
          {people.length === 0 ? (
            <Empty>
              {q
                ? "Nobody matches that."
                : before
                  ? "Nothing older than this."
                  : "No people yet."}
            </Empty>
          ) : (
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {people.map((p) => {
                const status = statusByUser.get(p.id as string);
                const staff = p.role !== "student";
                return (
                  <Row
                    key={p.id as string}
                    label={(p.full_name as string) || "No name"}
                    meta={p.email as string}
                    href={`/app/admin/people/${p.id}`}
                    // The destination is force-dynamic behind the segment's
                    // shared loading.tsx, so a prefetch buys the same static
                    // shell forty times over — see Row's own note. On a list
                    // that is thumb-scrolled end to end that is forty requests
                    // for nothing.
                    prefetch={false}
                    right={
                      // Stacked, not appended to `meta`. The role used to ride
                      // on the end of the email in a truncating mono line — at
                      // 320px the text column is ~136px, about 19 glyphs, and
                      // an ordinary gmail address is longer than that, so the
                      // one token saying "this is a mentor, not a student" was
                      // the one guaranteed to be cut. Not `leading` either:
                      // that slot is empty for the ~95% student rows and would
                      // shift the label's x-origin row to row.
                      staff || status ? (
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          {staff && (
                            <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                              {p.role as string}
                            </span>
                          )}
                          {status && <StatusBadge status={status} />}
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        {(older || newest) && (
          <div className="mt-6 flex items-center justify-center gap-5">
            {newest && (
              <Link
                href={newest}
                className="press inline-flex min-h-11 items-center text-[13px] text-ink-soft"
              >
                ↑ Newest
              </Link>
            )}
            {older && (
              <ActionLink href={older} size="sm">
                Older →
              </ActionLink>
            )}
          </div>
        )}
      </AppBody>
    </>
  );
}
