import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Applications · Admin" };

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const admin = createAdminClient();
  const status = searchParams.status;

  let q = admin
    .from("applications")
    .select(
      "id, full_name, age, status, created_at, submitted_at, why_join, profile:profiles!applications_user_id_fkey(email)",
    )
    .order("created_at", { ascending: false });
  if (status && status !== "all") q = q.eq("status", status);
  const { data: apps } = await q;

  const filters = ["all", "submitted", "accepted", "rejected", "paid", "draft"];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Applications</h1>
          <p className="mt-1 text-sm text-white/50">
            Review and decide on applications.
          </p>
        </div>
        <a
          href="/api/admin/export/applications"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10"
        >
          Export CSV
        </a>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {filters.map((f) => {
          const active = (status ?? "all") === f;
          return (
            <Link
              key={f}
              href={f === "all" ? "/admin/applications" : `/admin/applications?status=${f}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-spark bg-spark/10 text-spark"
                  : "border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {f}
            </Link>
          );
        })}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {(apps?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-white/50">No applications.</p>
        ) : (
          // CSS grid instead of <table> so each row can be a single <Link>
          // — that way clicking anywhere in the row navigates, not just
          // the applicant name.
          <div className="text-sm">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,0.5fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-white/10 px-5 py-3 text-xs uppercase tracking-wider text-white/40">
              <div>Applicant</div>
              <div>Email</div>
              <div>Age</div>
              <div>Status</div>
              <div>Submitted</div>
            </div>
            {apps!.map((a: any) => (
              <Link
                key={a.id}
                href={`/admin/applications/${a.id}`}
                className="group grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,0.5fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-b border-white/5 px-5 py-3 last:border-0 hover:bg-white/[0.02]"
              >
                <div className="truncate text-white group-hover:text-spark">
                  {a.full_name || "—"}
                </div>
                <div className="truncate text-white/60">
                  {a.profile?.email ?? "—"}
                </div>
                <div className="text-white/60">{a.age ?? "—"}</div>
                <div>
                  <StatusBadge status={a.status} />
                </div>
                <div className="text-white/50">
                  <LocalTime value={a.submitted_at} mode="date" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
