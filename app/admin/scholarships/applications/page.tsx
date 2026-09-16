import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  listScholarships,
  mapScholarshipApplication,
  describeAward,
  formatMoney,
} from "@/lib/scholarships";
import { SCHOLARSHIP_KIND_LABELS } from "@/lib/scholarship-award";

export const metadata = { title: "Scholarship queue · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = [
  { key: "open", label: "Needs a decision" },
  { key: "awarded", label: "Awarded" },
  { key: "refund_due", label: "Refund owed" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "All" },
] as const;

export default async function ScholarshipQueuePage(props: {
  searchParams: Promise<{ status?: string; scholarship?: string }>;
}) {
  const searchParams = await props.searchParams;
  await requirePermission("scholarships.view");

  const filter = FILTERS.some((f) => f.key === searchParams.status)
    ? searchParams.status!
    : "open";
  const scholarshipId = searchParams.scholarship ?? null;

  const admin = createAdminClient();
  const { scholarships, missingTable } = await listScholarships(admin);
  const byId = new Map(scholarships.map((s) => [s.id, s]));

  let query = admin
    .from("scholarship_applications")
    .select("*, student:profiles!scholarship_applications_user_id_fkey(full_name, email)")
    .limit(200);

  if (filter === "open") {
    // Oldest first: the person who has been waiting longest is at the top.
    query = query
      .in("status", ["submitted", "under_review"])
      .order("submitted_at", { ascending: true });
  } else if (filter === "refund_due") {
    query = query
      .eq("fulfillment", "refund_due")
      .order("decided_at", { ascending: true });
  } else if (filter === "all") {
    query = query.order("created_at", { ascending: false });
  } else {
    query = query.eq("status", filter).order("decided_at", { ascending: false });
  }
  if (scholarshipId) query = query.eq("scholarship_id", scholarshipId);

  const { data: rows } = await query;
  const apps = (rows ?? []).map((r) => ({
    app: mapScholarshipApplication(r as Record<string, any>),
    student: normalizeStudent((r as any).student),
  }));

  // Refunds owed, surfaced regardless of which filter is on: it's the only
  // state in this feature where a student is waiting on money and nothing will
  // happen until a human presses a button.
  const { count: refundsOwed } = await admin
    .from("scholarship_applications")
    .select("id", { count: "exact", head: true })
    .eq("fulfillment", "refund_due");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Scholarship queue</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Applications waiting on a decision, oldest first.
      </p>

      {missingTable && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            Run migration <code>0071_scholarships.sql</code> first.
          </p>
        </Card>
      )}

      {(refundsOwed ?? 0) > 0 && filter !== "refund_due" && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            <strong>
              {refundsOwed} {refundsOwed === 1 ? "award needs" : "awards need"} a
              refund issued.
            </strong>{" "}
            Those students have already paid and are waiting on money.{" "}
            <Link
              href="/admin/scholarships/applications?status=refund_due"
              className="underline hover:no-underline"
            >
              Show them →
            </Link>
          </p>
        </Card>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const href = `/admin/scholarships/applications?status=${f.key}${
            scholarshipId ? `&scholarship=${scholarshipId}` : ""
          }`;
          const active = f.key === filter;
          return (
            <Link
              key={f.key}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? "border-phosphor bg-phosphor/15 text-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {scholarshipId && byId.get(scholarshipId) && (
        <p className="mt-3 text-xs text-ink-faint">
          Filtered to <strong>{byId.get(scholarshipId)!.name}</strong> ·{" "}
          <Link
            href={`/admin/scholarships/applications?status=${filter}`}
            className="underline hover:no-underline"
          >
            clear
          </Link>
        </p>
      )}

      {apps.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            {filter === "open"
              ? "Nothing waiting on a decision. Nice."
              : "Nothing here."}
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {apps.map(({ app, student }) => {
            const scholarship = byId.get(app.scholarshipId);
            return (
              <Card key={app.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/scholarships/applications/${app.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {student.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {student.email}
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {scholarship ? (
                        <>
                          {scholarship.name} ·{" "}
                          <span className="text-phosphor-ink">
                            {describeAward(scholarship.terms)}
                          </span>{" "}
                          <span className="text-ink-faint">
                            ({SCHOLARSHIP_KIND_LABELS[scholarship.kind]})
                          </span>
                        </>
                      ) : (
                        "Scholarship deleted"
                      )}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {app.stageAtApply === "enrolled"
                        ? "Applied after enrolling"
                        : "Applied after acceptance"}
                      {app.submittedAt && (
                        <>
                          {" · "}
                          <LocalTime value={app.submittedAt} />
                        </>
                      )}
                      {Object.keys(app.answers).length > 0 &&
                        ` · ${Object.keys(app.answers).length} answers`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge status={app.status} />
                    {app.fulfillment === "refund_due" && (
                      <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                        {formatMoney(app.awardCents)} refund owed
                      </span>
                    )}
                    {app.fulfillment === "refunded" && (
                      <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                        {formatMoney(app.refundedCents)} refunded
                      </span>
                    )}
                    {app.credits.granted > 0 && (
                      <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                        {app.credits.remaining}/{app.credits.granted} calls left
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function normalizeStudent(raw: unknown): { name: string; email: string } {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const row = (s ?? {}) as Record<string, any>;
  return {
    name: row.full_name || row.email || "A student",
    email: row.email || "",
  };
}
