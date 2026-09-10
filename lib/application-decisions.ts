import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPassGrantForUser } from "@/lib/founder-pass";
import { announceAcceptance } from "@/lib/admissions";
import { markRebuildReviewedForUser } from "@/lib/founder-pass-perks";
import { Templates } from "@/lib/email/templates";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { notify } from "@/lib/notifications";
import { logAuditMany } from "@/lib/audit";

export type StructuredFeedback = {
  strongest?: string;
  missing?: string;
  nextStep?: string;
  secondReview?: boolean | null;
};

/**
 * The core of an application decision, minus the permission check.
 *
 * This is a PLAIN module (not "use server") on purpose: the reviewer-facing
 * server action guards with `assertPermission` and then calls in here, and the
 * scheduled-accept cron — which has no signed-in user — calls the same function
 * with the reviewer who parked the acceptance. Keeping it here means a
 * hand-clicked Accept and a scheduled one run byte-for-byte the same email,
 * Discord sync, audit row, and status write. `reviewerId` is always a real
 * person (the clicker, or whoever scheduled it), never a system actor, so
 * `reviewed_by` and the audit trail stay attributable.
 *
 * Any parked acceptance (migration 0062) is cleared as part of the write: a
 * decision — including a manual reject/waitlist that lands while an acceptance
 * was scheduled — supersedes and cancels the schedule.
 */
export async function applyApplicationDecision(
  applicationId: string,
  decision: "accepted" | "rejected" | "waitlisted",
  notes: string,
  reviewerId: string,
  feedback?: StructuredFeedback,
) {
  const admin = createAdminClient();

  // Fetch first so we can email + notify with full context. Note: we
  // deliberately don't pull discord_* columns here — they're added by
  // migration 0008 and may not exist yet. The Discord side-effect block
  // fetches them separately and tolerates a missing column.
  const { data: app, error: fetchErr } = await admin
    .from("applications")
    .select(
      "id, full_name, user_id, status, review_notes, cohort:cohorts(name, price_cents), profile:profiles!applications_user_id_fkey(email, full_name)",
    )
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !app) throw new Error(fetchErr?.message ?? "Not found");

  // Founder-pass perk, enforced where it can't be forgotten: a pass promises
  // "a real answer if it's a no" (app/pass/page.tsx), and a promise the admin
  // can skip on a busy day isn't a promise — see the referral card post-mortem
  // in that file. For pass holders the single-app UI collects STRUCTURED
  // feedback (strongest / missing / next step); a bulk decision has none and
  // must still carry a free-text note. Either way, a form-letter "no" to a pass
  // holder is impossible.
  // The grant, not just "do they hold one": the same read answers whether
  // structured feedback is mandatory AND what the acceptance email should
  // quote, and reading it twice would risk the two disagreeing.
  const applicantGrant = await getPassGrantForUser(admin, (app as any).user_id);
  const applicantHoldsPass = applicantGrant !== null;

  const f = feedback ?? {};
  const strongest = (f.strongest ?? "").trim();
  const missing = (f.missing ?? "").trim();
  const nextStep = (f.nextStep ?? "").trim();
  const hasStructured = !!(strongest || missing || nextStep);

  if (decision === "rejected" && applicantHoldsPass) {
    if (hasStructured) {
      if (!strongest || !missing || !nextStep) {
        throw new Error(
          "This applicant holds a founder pass. Its promise is a decline that " +
            "explains itself — fill in what was strongest, what was missing, " +
            "and the most useful next step before declining.",
        );
      }
    } else if (!notes.trim()) {
      throw new Error(
        "This applicant holds a founder pass, which guarantees written " +
          "feedback with a rejection. Write them feedback (it's sent to the " +
          "applicant) before declining.",
      );
    }
  }

  // review_notes stays the single source the email + the applicant's existing
  // surfaces read, so on a rejection with structured feedback we COMPOSE it
  // from the parts. That keeps the feedback intact even on a database where the
  // structured columns don't exist yet (the write below tolerates that), and
  // means the rejection email carries the same words the dashboard shows.
  const effectiveNotes =
    decision === "rejected" && hasStructured
      ? composeStructuredNotes({ strongest, missing, nextStep, notes, secondReview: f.secondReview })
      : notes;

  // Clearing the parked-acceptance columns (0062) is part of every decision:
  // the acceptance has now fired, or a manual reject/waitlist has superseded it.
  const baseUpdate = {
    status: decision,
    review_notes: effectiveNotes || null,
    reviewed_at: new Date().toISOString(),
    reviewed_by: reviewerId,
    scheduled_accept_at: null,
    scheduled_accept_notes: null,
    scheduled_accept_by: null,
  };
  const structuredUpdate =
    decision === "rejected" && hasStructured
      ? {
          feedback_strongest: strongest || null,
          feedback_missing: missing || null,
          feedback_next_step: nextStep || null,
          feedback_second_review:
            typeof f.secondReview === "boolean" ? f.secondReview : null,
        }
      : {};

  let { error } = await admin
    .from("applications")
    .update({ ...baseUpdate, ...structuredUpdate })
    .eq("id", applicationId);
  // Tolerate migration 0041 not being applied yet: a missing feedback_* column
  // must never brick the decision. review_notes already carries the composed
  // feedback, so retrying without the structured columns loses only the
  // discrete display, not the words — the same fallback 0040 uses for
  // redeemed_code.
  if (error && /feedback_(strongest|missing|next_step|second_review)/i.test(error.message)) {
    ({ error } = await admin
      .from("applications")
      .update(baseUpdate)
      .eq("id", applicationId));
  }
  // Same tolerance one migration newer: if 0062 isn't applied yet the
  // scheduled_accept_* columns don't exist. Nothing could have been parked on a
  // database that lacks the columns, so dropping them from the write loses
  // nothing — retry with just the decision.
  if (error && /scheduled_accept_(at|notes|by)/i.test(error.message)) {
    const { scheduled_accept_at, scheduled_accept_notes, scheduled_accept_by, ...rest } =
      baseUpdate;
    ({ error } = await admin
      .from("applications")
      .update({ ...rest, ...structuredUpdate })
      .eq("id", applicationId));
    if (error && /feedback_(strongest|missing|next_step|second_review)/i.test(error.message)) {
      ({ error } = await admin
        .from("applications")
        .update(rest)
        .eq("id", applicationId));
    }
  }
  if (error) throw new Error(error.message);

  // A decision on a pass holder closes any outstanding seven-day rebuild — this
  // decision IS the fresh review the rebuild earned. Best-effort / no-op when
  // there's no rebuild.
  if (applicantHoldsPass) {
    await markRebuildReviewedForUser(admin, (app as any).user_id, reviewerId);
  }

  await logAuditMany({ userId: reviewerId }, [
    {
      action: `application.${decision}`,
      targetType: "application",
      targetId: applicationId,
      payload: {
        before: {
          status: (app as any).status,
          review_notes: (app as any).review_notes,
        },
        after: { status: decision, review_notes: effectiveNotes || null },
        notes: effectiveNotes || null,
      },
    },
  ]);

  // Email + in-app notify the applicant.
  try {
    const a = app as any;
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    const listPriceCents = cohort?.price_cents ?? 13000;
    if (decision === "accepted") {
      // Every acceptance — clicked here, or granted automatically by a virtual
      // founder pass on submit — goes out through the one function in
      // lib/admissions.ts. Holders pay less by their GRANT (tier plus any
      // hand-set override, migrations 0055/0056) and checkout applies that
      // server-side, so having two copies of "compose the acceptance" was one
      // edit away from the email quoting a price Stripe doesn't charge.
      await announceAcceptance(
        admin,
        {
          id: a.id,
          user_id: a.user_id,
          full_name: a.full_name ?? null,
          cohortName: cohort?.name ?? null,
          listPriceCents,
          applicantEmail: profile?.email ?? null,
          applicantName: a.full_name ?? profile?.full_name ?? null,
        },
        applicantGrant,
      );
    } else if (decision === "waitlisted") {
      const waitlistedName = a.full_name ?? profile?.full_name ?? null;
      if (profile?.email) {
        await sendTemplated("application.waitlisted", {
          to: profile.email,
          toName: waitlistedName,
          userId: a.user_id,
          vars: {
            cohort_name: cohort?.name ?? "batch0",
            review_notes: effectiveNotes || "",
            application_status: "waitlisted",
          },
          fallback: () =>
            Templates.applicationWaitlisted({
              name: waitlistedName,
              cohortName: cohort?.name ?? "batch0",
              notes: effectiveNotes || null,
            }),
        });
        await emitEmailEvent("application.waitlisted", {
          email: profile.email,
          name: waitlistedName,
          userId: a.user_id,
          vars: {
            cohort_name: cohort?.name ?? "batch0",
            review_notes: effectiveNotes || "",
            application_status: "waitlisted",
          },
          dedupeSeed: `application.waitlisted:${a.id}`,
        });
      }
      await notify({
        userId: a.user_id,
        type: "application_waitlisted",
        title: "You're on the waitlist",
        body: "Not a no — if a seat opens, you're first in line.",
        link: "/dashboard/application",
      });
    } else {
      const rejectedName = a.full_name ?? profile?.full_name ?? null;
      if (profile?.email) {
        await sendTemplated("application.rejected", {
          to: profile.email,
          toName: rejectedName,
          userId: a.user_id,
          vars: {
            review_notes: effectiveNotes || "",
            application_status: "rejected",
          },
          fallback: () =>
            Templates.applicationRejected({
              name: rejectedName,
              notes: effectiveNotes || null,
            }),
        });
        await emitEmailEvent("application.rejected", {
          email: profile.email,
          name: rejectedName,
          userId: a.user_id,
          vars: {
            review_notes: effectiveNotes || "",
            application_status: "rejected",
          },
          dedupeSeed: `application.rejected:${a.id}`,
        });
      }
      await notify({
        userId: a.user_id,
        type: "application_rejected",
        title: "Application decision",
        body: "You weren't selected for this cohort.",
        link: "/dashboard/application",
      });
    }
  } catch (err) {
    console.error("[applications] decide notify failed", err);
  }

  // The Discord role sync and the staff-feed post used to live here as a
  // separate `if (decision === "accepted")` block. They moved into
  // announceAcceptance() with the email, because they are the same event: an
  // acceptance that emails the student but never gives them the Discord role
  // is a half-admission, and the auto-admit path needs both too.

  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

/**
 * Fold the four structured feedback parts into the single review_notes string
 * the rejection email and the applicant's dashboard fall back to. The dashboard
 * renders the discrete columns when they exist; this text is what carries the
 * feedback everywhere else (and on a pre-0041 database, everywhere).
 */
export function composeStructuredNotes(args: {
  strongest: string;
  missing: string;
  nextStep: string;
  notes: string;
  secondReview?: boolean | null;
}): string {
  const parts = [
    `What was strongest:\n${args.strongest}`,
    `What was missing:\n${args.missing}`,
    `Most useful next step:\n${args.nextStep}`,
  ];
  if (args.secondReview === true) {
    parts.push(
      "You're eligible for another look — complete the seven-day build to earn a fresh review.",
    );
  }
  const extra = args.notes.trim();
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}
