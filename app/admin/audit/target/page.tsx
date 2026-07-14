import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Audit history · Admin" };
export const dynamic = "force-dynamic";

export default async function AuditTargetPage({
  searchParams,
}: {
  searchParams: { type?: string; id?: string };
}) {
  await requireAdmin();
  const type = (searchParams.type ?? "").trim();
  const id = (searchParams.id ?? "").trim();
  if (!type || !id) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link
          href="/admin/audit"
          className="text-sm text-ink-soft hover:text-ink"
        >
          ← Audit log
        </Link>
        <p className="mt-6 text-sm text-ink-soft">
          Pass <code>?type=...&id=...</code> in the URL. Linked from any
          domain row that calls{" "}
          <code>logAudit(...)</code> with a target.
        </p>
      </div>
    );
  }
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("audit_log")
    .select("id, actor_email, action, payload, created_at")
    .eq("target_type", type)
    .eq("target_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/audit"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Audit log
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        {type} · {id.slice(0, 8)}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Append-only history. Newest first.
      </p>

      {(rows?.length ?? 0) === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            No audit entries for this target.
          </p>
        </Card>
      ) : (
        <ol className="mt-6 space-y-3">
          {(rows ?? []).map((r: any) => {
            const payload = r.payload ?? {};
            const before = payload.before ?? null;
            const after = payload.after ?? null;
            const hasDiff = before && after;
            return (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-sm font-semibold text-phosphor-ink">
                      {r.action}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {r.actor_email ?? "system"} ·{" "}
                      <LocalTime value={r.created_at} />
                    </p>
                  </div>
                  {hasDiff ? (
                    <Diff before={before} after={after} />
                  ) : (
                    <pre className="mt-3 max-h-60 overflow-auto rounded-lg border border-line bg-wash p-3 text-[11px] text-ink-soft">
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Diff({
  before,
  after,
}: {
  before: Record<string, any>;
  after: Record<string, any>;
}) {
  const keys = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).sort();
  const changed = keys.filter(
    (k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
  );
  if (changed.length === 0) {
    return (
      <p className="mt-3 text-xs text-ink-faint">
        No diff (payload had identical before/after).
      </p>
    );
  }
  return (
    <table className="mt-3 w-full text-xs">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
          <th className="pb-2">Field</th>
          <th className="pb-2">Before</th>
          <th className="pb-2">After</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {changed.map((k) => (
          <tr key={k}>
            <td className="py-2 font-mono text-ink-soft">{k}</td>
            <td className="py-2 text-red-700 dark:text-red-300">
              {format(before?.[k])}
            </td>
            <td className="py-2 text-emerald-700 dark:text-emerald-300">{format(after?.[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function format(v: any): string {
  if (v == null) return "—";
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  return JSON.stringify(v).slice(0, 80);
}
