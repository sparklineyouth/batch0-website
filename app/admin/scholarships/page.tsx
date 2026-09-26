import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import {
  listScholarships,
  awardedCountsByCohort,
  awardedIn,
  awardedTotal,
  listLiveCohorts,
  describeAward,
} from "@/lib/scholarships";
import { SCHOLARSHIP_KIND_LABELS, awardTypeOf } from "@/lib/scholarship-award";
import { describeCohortWindows } from "@/lib/scholarship-window";
import { ScholarshipRowActions } from "./row-actions";

export const metadata = { title: "Scholarships · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminScholarshipsPage() {
  const viewer = await requirePermission("scholarships.view");
  const canManage = can(viewer.caps, "scholarships.manage");

  const admin = createAdminClient();
  const [{ scholarships, missingTable }, counts, liveCohorts] = await Promise.all([
    listScholarships(admin),
    awardedCountsByCohort(admin),
    listLiveCohorts(admin),
  ]);
  const now = new Date();

  // Pending applications per scholarship, so the list says where the work is.
  const { data: pendingRows } = await admin
    .from("scholarship_applications")
    .select("scholarship_id")
    .in("status", ["submitted", "under_review"]);
  const pending = new Map<string, number>();
  for (const r of (pendingRows ?? []) as Array<{ scholarship_id: string }>) {
    pending.set(r.scholarship_id, (pending.get(r.scholarship_id) ?? 0) + 1);
  }
  const totalPending = [...pending.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Scholarships</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Need-based, merit, and the learner's grant. Students hold one at a
            time and can apply after acceptance or after enrolling. There are no
            dates to set: each student&apos;s window follows their cohort —
            accepted students until its enrollment deadline, enrolled students
            until it ends — and seat limits count per cohort.
          </p>
        </div>
        {canManage && (
          <ButtonLink href="/admin/scholarships/new">New scholarship</ButtonLink>
        )}
      </div>

      {missingTable && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            The <code>scholarships</code> table isn't there yet. Run migration{" "}
            <code>0071_scholarships.sql</code> in the Supabase SQL editor, then
            reload.
          </p>
        </Card>
      )}

      {totalPending > 0 && (
        <Card className="mt-6 border-phosphor/40 bg-phosphor/5">
          <p className="text-sm text-ink">
            <strong>
              {totalPending} {totalPending === 1 ? "application is" : "applications are"}
            </strong>{" "}
            waiting on a decision.{" "}
            <Link
              href="/admin/scholarships/applications"
              className="underline hover:no-underline"
            >
              Open the queue →
            </Link>
          </p>
        </Card>
      )}

      {scholarships.length === 0 && !missingTable ? (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            No scholarships yet.{" "}
            {canManage
              ? "Create one and it appears on every accepted student's dashboard."
              : "Nobody has created one yet."}
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {scholarships.map((s) => {
            const awarded = awardedTotal(counts, s.id);
            const waiting = pending.get(s.id) ?? 0;
            const awardType = awardTypeOf(s.terms);
            return (
              <Card key={s.id} className={s.enabled ? "" : "opacity-60"}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/scholarships/${s.id}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {s.name}
                      </Link>
                      <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                        {SCHOLARSHIP_KIND_LABELS[s.kind]}
                      </span>
                      {!s.enabled && (
                        <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-phosphor-ink">
                      {describeAward(s.terms)}
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">
                      <code>/{s.slug}</code> · {s.eligibleStages.join(" + ")} ·{" "}
                      {awarded} awarded
                      {s.seats !== null && ` · ${s.seats} seats per cohort`}
                      {s.questions.filter((q) => !q.hidden).length > 0 &&
                        ` · ${s.questions.filter((q) => !q.hidden).length} questions`}
                    </p>
                    {/* The live windows, one line per upcoming or running
                        cohort — what a student in each would see right now. */}
                    {s.enabled && (
                      <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
                        {liveCohorts.length === 0 ? (
                          <li>
                            No upcoming or running cohort, so nobody can apply
                            until one is set up.
                          </li>
                        ) : (
                          liveCohorts.map((c) => {
                            const taken = awardedIn(counts, s.id, c.id);
                            return (
                              <li key={c.id}>
                                <span className="font-medium text-ink">
                                  {c.name ?? "Unnamed cohort"}
                                </span>
                                {" — "}
                                {describeCohortWindows(
                                  { cohort: c, stages: s.eligibleStages, awardType },
                                  now,
                                )}
                                {s.seats !== null
                                  ? ` · ${taken} of ${s.seats} seats awarded`
                                  : taken > 0
                                    ? ` · ${taken} awarded`
                                    : ""}
                              </li>
                            );
                          })
                        )}
                      </ul>
                    )}
                    {waiting > 0 && (
                      <Link
                        href={`/admin/scholarships/applications?scholarship=${s.id}`}
                        className="mt-2 inline-block text-xs font-medium text-phosphor-ink underline hover:no-underline"
                      >
                        {waiting} waiting on a decision →
                      </Link>
                    )}
                  </div>
                  {canManage && (
                    <ScholarshipRowActions
                      id={s.id}
                      name={s.name}
                      enabled={s.enabled}
                      hasApplicants={awarded + waiting > 0}
                    />
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
