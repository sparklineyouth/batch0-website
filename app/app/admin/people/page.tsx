import Link from "next/link";
import { Search } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { AppHeader, AppBody, Empty, Row } from "@/components/app/frame";

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
 */
export default async function AdminAppPeople({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  await requirePermission("people.view");
  const admin = createAdminClient();
  const q = (searchParams.q ?? "").trim();

  let query = admin
    .from("profiles")
    .select("id, full_name, email, role")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (q) {
    // Escaped for PostgREST's `or` grammar: a comma or a parenthesis in the
    // query string would otherwise be read as filter syntax and either widen
    // the search or 400 the request.
    const safe = q.replace(/[,()]/g, " ");
    query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`);
  }
  const { data: people } = await query;

  // Application status for exactly the rows on screen — one query for the page.
  const ids = (people ?? []).map((p) => p.id as string);
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

  return (
    <>
      <AppHeader title="People" eyebrow={q ? `“${q}”` : "Students and staff"} />
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
          {(people ?? []).length === 0 ? (
            <Empty>{q ? "Nobody matches that." : "No people yet."}</Empty>
          ) : (
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {(people ?? []).map((p) => {
                const status = statusByUser.get(p.id as string);
                return (
                  <Row
                    key={p.id as string}
                    label={(p.full_name as string) || "No name"}
                    meta={`${p.email as string}${
                      p.role !== "student" ? ` · ${p.role}` : ""
                    }`}
                    href={`/app/admin/people/${p.id}`}
                    right={
                      status ? (
                        <span className="shrink-0">
                          <StatusBadge status={status} />
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        {(people ?? []).length === PAGE_SIZE && (
          <p className="mt-4 text-center text-[12px] text-ink-faint">
            Showing the first {PAGE_SIZE}. Narrow the search, or use{" "}
            <Link
              href="/admin/students"
              prefetch={false}
              className="text-phosphor-ink underline"
            >
              the full directory
            </Link>
            .
          </p>
        )}
      </AppBody>
    </>
  );
}
