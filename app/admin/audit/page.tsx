import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export const metadata = { title: "Audit log · Admin" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const ACTION_COLORS: Record<string, string> = {
  "user.role_changed": "text-amber-700 dark:text-amber-300",
  "application.accepted": "text-emerald-700 dark:text-emerald-300",
  "application.rejected": "text-red-700 dark:text-red-300",
  "application.reopened": "text-blue-700 dark:text-blue-300",
  "application.ai_screened": "text-violet-700 dark:text-violet-300",
  "cohort.created": "text-emerald-700 dark:text-emerald-300",
  "cohort.updated": "text-blue-700 dark:text-blue-300",
  "cohort.deleted": "text-red-700 dark:text-red-300",
  "settings.updated": "text-blue-700 dark:text-blue-300",
  "payment.refunded": "text-red-700 dark:text-red-300",
};

type SearchParams = {
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: string;
};

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Accept YYYY-MM-DD only. Cheaper than trusting Date constructor with
  // user input — we don't need timezone math here.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

function buildQuery(
  current: SearchParams,
  overrides: Partial<Record<keyof SearchParams, string | number | undefined>>,
): string {
  const merged: Record<string, string | number | undefined> = {
    ...current,
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `/admin/audit?${s}` : "/admin/audit";
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const admin = createAdminClient();

  const action = searchParams.action?.trim() || undefined;
  const actor = searchParams.actor?.trim() || undefined;
  const fromDate = parseDate(searchParams.from);
  const toDate = parseDate(searchParams.to);
  const page = parsePage(searchParams.page);
  const offset = (page - 1) * PAGE_SIZE;

  // Pull the full set of distinct actions so the filter chips don't
  // depend on the current page's window. Limit to 200 distinct values
  // as a soft cap — every action we care about lives in lib/audit.ts.
  const { data: actionRowsRaw } = await admin
    .from("audit_log")
    .select("action")
    .limit(2000);
  const allActions = Array.from(
    new Set((actionRowsRaw ?? []).map((r: any) => r.action as string)),
  ).sort();

  // Build the main query with all filters applied. We need both the
  // page data and a total count for pagination; PostgREST gives us that
  // via { count: "exact" } in a single round-trip.
  let q = admin
    .from("audit_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (action) q = q.eq("action", action);
  if (actor) q = q.ilike("actor_email", `%${actor}%`);
  if (fromDate) q = q.gte("created_at", `${fromDate}T00:00:00.000Z`);
  if (toDate) {
    // "to" is inclusive of the entire day → end of day UTC.
    q = q.lte("created_at", `${toDate}T23:59:59.999Z`);
  }
  const { data: rows, count } = await q;

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const hasActiveFilters = Boolean(action || actor || fromDate || toDate);

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Audit log</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Append-only record of admin actions. {totalCount.toLocaleString()} total
        entries.
      </p>

      {/* Filter bar — server-rendered GET form. Each input is a search
          param, so links + bookmarks survive page reloads. */}
      <Card className="mt-6">
        <form
          method="GET"
          action="/admin/audit"
          className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <label className="block text-sm">
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              Actor email
            </span>
            <input
              type="text"
              name="actor"
              defaultValue={actor ?? ""}
              placeholder="anything@…"
              className="mt-1 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-spark focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              From
            </span>
            <input
              type="date"
              name="from"
              defaultValue={fromDate ?? ""}
              className="mt-1 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-spark focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              To
            </span>
            <input
              type="date"
              name="to"
              defaultValue={toDate ?? ""}
              className="mt-1 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink focus:border-spark focus:outline-none"
            />
          </label>
          {/* Keep action filter alive across submissions of the text form. */}
          {action && <input type="hidden" name="action" value={action} />}
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-md bg-spark px-4 py-2 text-sm font-semibold text-on-spark shadow-cta hover:bg-spark-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              Apply
            </button>
            {hasActiveFilters && (
              <Link
                href="/admin/audit"
                className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-2 text-sm text-ink-soft hover:border-ink/30 hover:bg-wash"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Link>
            )}
          </div>
        </form>
      </Card>

      {/* Action chip filter — preserves the other filters via buildQuery. */}
      {allActions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-faint">
            Action
          </span>
          <Link
            href={buildQuery(searchParams, { action: undefined, page: undefined })}
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
              !action
                ? "border-spark bg-spark/10 text-spark"
                : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
            }`}
          >
            All
          </Link>
          {allActions.map((a) => (
            <Link
              key={a}
              href={buildQuery(searchParams, { action: a, page: undefined })}
              className={`rounded-full border px-3 py-1 text-xs lowercase tracking-wider transition ${
                action === a
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {a}
            </Link>
          ))}
        </div>
      )}

      <Card className="mt-6 !p-0 overflow-hidden">
        {(rows?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-ink-faint">
            No entries match those filters.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3">Actor</th>
                <th className="px-5 py-3">Action</th>
                <th className="px-5 py-3">Target</th>
                <th className="px-5 py-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r: any) => (
                <tr
                  key={r.id}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-5 py-3 text-ink-soft whitespace-nowrap">
                    <LocalTime value={r.created_at} />
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {r.actor_email ? (
                      <Link
                        href={buildQuery(searchParams, {
                          actor: r.actor_email,
                          page: undefined,
                        })}
                        className="hover:text-spark-ink hover:underline"
                      >
                        {r.actor_email}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    className={`px-5 py-3 font-mono text-xs ${
                      ACTION_COLORS[r.action] ?? "text-ink-soft"
                    }`}
                  >
                    <Link
                      href={buildQuery(searchParams, {
                        action: r.action,
                        page: undefined,
                      })}
                      className="hover:underline"
                    >
                      {r.action}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-ink-faint">
                    {r.target_type && r.target_id ? (
                      <Link
                        href={`/admin/audit/target?type=${encodeURIComponent(r.target_type)}&id=${encodeURIComponent(r.target_id)}`}
                        className="hover:text-spark-ink hover:underline"
                      >
                        {r.target_type}:{r.target_id.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] text-ink-faint">
                    {r.payload
                      ? JSON.stringify(r.payload).slice(0, 200)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-xs text-ink-soft">
        <span>
          Page {page} of {totalPages} · showing{" "}
          {Math.min(offset + 1, totalCount)}–
          {Math.min(offset + PAGE_SIZE, totalCount)}
        </span>
        <div className="flex gap-1">
          {page > 1 ? (
            <Link
              href={buildQuery(searchParams, { page: page - 1 })}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </span>
          )}
          {page < totalPages ? (
            <Link
              href={buildQuery(searchParams, { page: page + 1 })}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 hover:bg-wash"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-ink-faint">
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
