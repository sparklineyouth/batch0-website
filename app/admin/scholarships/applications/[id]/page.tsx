import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  mapScholarship,
  mapScholarshipApplication,
  listApplicationsForUser,
  describeAward,
  formatMoney,
} from "@/lib/scholarships";
import {
  awardRefundCents,
  awardDiscountCents,
  SCHOLARSHIP_KIND_LABELS,
} from "@/lib/scholarship-award";
import { formatAnswer } from "@/lib/question-schema";
import { ReviewActions } from "./review-actions";

export const metadata = { title: "Scholarship application · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ScholarshipApplicationPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const viewer = await requirePermission("scholarships.view");
  const canManage = can(viewer.caps, "scholarships.manage");

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("scholarship_applications")
    .select(
      "*, scholarship:scholarships(*), student:profiles!scholarship_applications_user_id_fkey(full_name, email, contact_email)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!row) notFound();

  const app = mapScholarshipApplication(row as Record<string, any>);
  const scholarshipRow = (row as any).scholarship;
  const scholarship = scholarshipRow ? mapScholarship(scholarshipRow) : null;
  const student = normalizeStudent((row as any).student);

  // What they've paid, if anything — this is what decides discount vs refund,
  // and it bounds the refund amount.
  const { data: payment } = await admin
    .from("payments")
    .select("id, amount_cents, stripe_payment_intent_id, stripe_receipt_url, created_at")
    .eq("user_id", app.userId)
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const paidCents = payment ? Number((payment as any).amount_cents) || 0 : 0;
  const hasPaid = paidCents > 0;

  // The other scholarships this student has touched — the one-at-a-time rule
  // is re-checked at award time, so a reviewer should see it coming.
  const otherApps = (await listApplicationsForUser(admin, app.userId)).filter(
    (a) => a.id !== app.id,
  );
  const otherLive = otherApps.filter(
    (a) =>
      a.status === "awarded" || a.status === "submitted" || a.status === "under_review",
  );

  // The figure the reviewer is about to commit to, computed the same way the
  // award action will compute it — so the button and the outcome agree.
  const projected = scholarship
    ? hasPaid
      ? awardRefundCents(scholarship.terms, paidCents, app.refundedCents)
      : awardDiscountCents(scholarship.terms, 13000)
    : 0;

  const answered = scholarship
    ? scholarship.questions.filter((q) => formatAnswer(q, app.answers) !== "")
    : [];
  const unanswered = scholarship
    ? scholarship.questions.filter(
        (q) => !q.hidden && formatAnswer(q, app.answers) === "",
      )
    : [];

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/scholarships/applications"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Scholarship queue
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{student.name}</h1>
          <p className="mt-1 text-sm text-ink-soft">{student.email}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {scholarship ? (
              <>
                Applied for <strong className="text-ink">{scholarship.name}</strong>{" "}
                · {SCHOLARSHIP_KIND_LABELS[scholarship.kind]} ·{" "}
                <span className="text-phosphor-ink">
                  {describeAward(scholarship.terms)}
                </span>
              </>
            ) : (
              "The scholarship they applied for has been deleted."
            )}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {app.stageAtApply === "enrolled"
              ? "Applied after enrolling"
              : "Applied after acceptance"}
            {app.submittedAt && (
              <>
                {" · submitted "}
                <LocalTime value={app.submittedAt} />
              </>
            )}
          </p>
        </div>
        <StatusBadge status={app.status} />
      </div>

      {/* Where the money stands. Put above the answers because it's what
          changes what the decision MEANS — awarding someone who has already
          paid is a refund, and a reviewer should know that before reading. */}
      <Card className="mt-6">
        <h2 className="text-sm font-medium text-ink">Money</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row
            label="Tuition paid"
            value={hasPaid ? formatMoney(paidCents) : "Not yet"}
          />
          {scholarship?.terms.awardType === "discount" && (
            <Row
              label={hasPaid ? "Refund if awarded" : "Discount if awarded"}
              value={projected > 0 ? formatMoney(projected) : "—"}
            />
          )}
          {scholarship?.terms.awardType === "mentor_calls" && (
            <Row
              label="Grants"
              value={`${scholarship.terms.mentorCalls} mentor calls`}
            />
          )}
          {app.refundedCents > 0 && (
            <Row label="Already refunded" value={formatMoney(app.refundedCents)} />
          )}
          {app.credits.granted > 0 && (
            <Row
              label="Mentor calls"
              value={`${app.credits.used} used of ${app.credits.granted}`}
            />
          )}
        </dl>
        <p className="mt-3 text-xs text-ink-faint">
          {hasPaid
            ? "They've already paid, so a money award is issued as a partial refund against that charge — a separate, deliberate step after awarding. Their enrollment is unaffected."
            : "They haven't paid yet, so a money award comes off their checkout automatically. Nothing to issue by hand."}
        </p>
      </Card>

      {otherLive.length > 0 && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            This student has {otherLive.length} other live scholarship{" "}
            {otherLive.length === 1 ? "application" : "applications"}
            {otherLive.some((a) => a.status === "awarded") && (
              <>
                {" "}
                — <strong>including one already awarded</strong>. Students hold
                one at a time, so awarding this will be refused until that one
                is revoked.
              </>
            )}
            .
          </p>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-sm font-medium text-ink">Their answers</h2>
        {answered.length === 0 && unanswered.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            This scholarship asks no questions.
          </p>
        ) : (
          <dl className="mt-3 space-y-4">
            {answered.map((q) => (
              <div key={q.id}>
                <dt className="text-xs uppercase tracking-wider text-ink-faint">
                  {q.label}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm text-ink [overflow-wrap:anywhere]">
                  {formatAnswer(q, app.answers)}
                </dd>
              </div>
            ))}
            {unanswered.length > 0 && (
              <p className="text-xs text-ink-faint">
                Left blank: {unanswered.map((q) => q.label).join(", ")}
              </p>
            )}
          </dl>
        )}
      </Card>

      {app.decisionNote && (
        <Card className="mt-6">
          <h2 className="text-sm font-medium text-ink">Decision note</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
            {app.decisionNote}
          </p>
          {app.decidedAt && (
            <p className="mt-2 text-xs text-ink-faint">
              <LocalTime value={app.decidedAt} />
            </p>
          )}
        </Card>
      )}

      {canManage ? (
        <div className="mt-6">
          <ReviewActions
            applicationId={app.id}
            status={app.status}
            fulfillment={app.fulfillment}
            awardType={scholarship?.terms.awardType ?? "discount"}
            projectedCents={projected}
            awardCents={app.awardCents}
            refundedCents={app.refundedCents}
            hasPaid={hasPaid}
            paidCents={paidCents}
            creditsUsed={app.credits.used}
            studentName={student.name}
            defaultNote={app.decisionNote ?? ""}
          />
        </div>
      ) : (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Deciding this needs the "Award scholarships" permission.
          </p>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0">
      <dt className="text-xs uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function normalizeStudent(raw: unknown): { name: string; email: string } {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const row = (s ?? {}) as Record<string, any>;
  return {
    name: row.full_name || row.email || "A student",
    email: row.contact_email || row.email || "",
  };
}
