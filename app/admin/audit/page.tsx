import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Audit log · Admin" };

const ACTION_COLORS: Record<string, string> = {
  "user.role_changed": "text-amber-300",
  "application.accepted": "text-emerald-300",
  "application.rejected": "text-red-300",
  "application.reopened": "text-blue-300",
  "cohort.created": "text-emerald-300",
  "cohort.updated": "text-blue-300",
  "cohort.deleted": "text-red-300",
  "settings.updated": "text-blue-300",
  "payment.refunded": "text-red-300",
};

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: { action?: string };
}) {
  const admin = createAdminClient();
  const filter = searchParams.action;

  let q = admin
    .from("audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (filter) q = q.eq("action", filter);
  const { data: rows } = await q;

  const allActions = Array.from(
    new Set((rows ?? []).map((r: any) => r.action)),
  ).sort();

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-white/50">
        Append-only record of admin actions. Last 500 entries.
      </p>

      {allActions.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-white/40">
            Action
          </span>
          <a
            href="/admin/audit"
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
              !filter
                ? "border-spark bg-spark/10 text-spark"
                : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
            }`}
          >
            All
          </a>
          {allActions.map((a) => (
            <a
              key={a}
              href={`/admin/audit?action=${encodeURIComponent(a)}`}
              className={`rounded-full border px-3 py-1 text-xs lowercase tracking-wider transition ${
                filter === a
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {a}
            </a>
          ))}
        </div>
      )}

      <Card className="mt-6 !p-0 overflow-hidden">
        {(rows?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-white/50">No entries.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
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
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-5 py-3 text-white/60">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {r.actor_email ?? "—"}
                  </td>
                  <td
                    className={`px-5 py-3 font-mono text-xs ${
                      ACTION_COLORS[r.action] ?? "text-white/80"
                    }`}
                  >
                    {r.action}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-white/40">
                    {r.target_type
                      ? `${r.target_type}:${r.target_id?.slice(0, 8) ?? ""}`
                      : "—"}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] text-white/50">
                    {r.payload ? JSON.stringify(r.payload).slice(0, 200) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
