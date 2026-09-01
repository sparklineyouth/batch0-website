import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { Templates } from "@/lib/email/templates";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { notify } from "@/lib/notifications";
import { logAuditMany } from "@/lib/audit";
import {
  syncMemberRoles,
  postChannelMessage,
  announcementEmbed,
  getDiscordSettings,
} from "@/lib/discord";
import { getPassForUser } from "@/lib/founder-pass";
import { reviewerOverrodePass, type DecidedApplication } from "@/lib/reapply";
import {
  grantAutoAdmits,
  grantDiscountCents,
  type PassGrant,
} from "@/lib/founder-pass-tiers";

// Admission side-effects, in one place.
//
// An acceptance is not one write. It is a status change, an email that quotes
// the exact tuition checkout will charge, an in-app notification, a Discord
// role sync and a line in the staff feed — and until now all six lived inside
// app/admin/applications/[id]/actions.ts, reachable only by an admin clicking
// "Accept". The auto-admit perk (a virtual founder pass admits its holder on
// submit) needs the same six from a completely different entry point, and
// copy-pasting them is how one path ends up quoting last season's price or
// silently skipping the Discord role.
//
// So the announcement is extracted here and BOTH paths call it. Everything
// below is best-effort by design: the seat is already granted by the time this
// runs, and a Discord outage must never un-admit somebody.
//
// Takes a service-role client. Do not import into a client component.

/** The joined shape both callers already hold after reading the application. */
export type AcceptedApplication = {
  id: string;
  user_id: string;
  full_name?: string | null;
  cohortName: string | null;
  /** List price for the cohort, in cents, BEFORE any pass discount. */
  listPriceCents: number;
  applicantEmail: string | null;
  applicantName: string | null;
};

/**
 * Everything that happens after an application's status becomes "accepted".
 *
 * `grant` is the applicant's founder-pass grant if they hold one — passed in
 * rather than re-read, so the number in this email is the same number the
 * caller resolved when it decided the price. Reading it twice is how the
 * acceptance email and checkout end up disagreeing.
 *
 * Uses the LIST price, not a regional one: both callers run without the
 * applicant's geography to hand (an admin request, or a submit that hasn't
 * routed through pricing). Someone on a regional price is quoted slightly high
 * and then charged less by checkout; a full ride resolves to $0 either way,
 * since the discount clamps to whatever price it is given.
 */
export async function announceAcceptance(
  admin: SupabaseClient,
  app: AcceptedApplication,
  grant: PassGrant | null,
): Promise<void> {
  const cohortName = app.cohortName ?? "batch0";
  const priceCents = Math.max(
    0,
    app.listPriceCents -
      (grant ? grantDiscountCents(grant, app.listPriceCents) : 0),
  );
  const vars = {
    cohort_name: cohortName,
    amount: `$${(priceCents / 100).toFixed(0)}`,
    application_status: "accepted",
    pay_url: `${env.siteUrl}/dashboard/accepted`,
  };

  try {
    if (app.applicantEmail) {
      await sendTemplated("application.accepted", {
        to: app.applicantEmail,
        toName: app.applicantName,
        userId: app.user_id,
        vars,
        fallback: () =>
          Templates.applicationAccepted({
            name: app.applicantName,
            cohortName,
            priceCents,
          }),
      });
      // Anything an admin has built on top of the acceptance — a payment nudge
      // three days later, say — hangs off this.
      await emitEmailEvent("application.accepted", {
        email: app.applicantEmail,
        name: app.applicantName,
        userId: app.user_id,
        vars,
        dedupeSeed: `application.accepted:${app.id}`,
      });
    }
    await notify({
      userId: app.user_id,
      type: "application_accepted",
      title: "You're in",
      body: `Welcome to ${cohortName}. Pay to lock in your seat.`,
      link: "/dashboard/accepted",
    });
  } catch (err) {
    console.error("[admissions] accept notify failed", err);
  }

  // Discord. Tolerant of migration 0008 not being applied (no discord_user_id
  // column), which is why the handle read is wrapped rather than named in a
  // select the caller shares.
  try {
    const { data, error } = await admin
      .from("profiles")
      .select("discord_user_id, role")
      .eq("id", app.user_id)
      .maybeSingle();
    const handle =
      error && (error as { code?: string }).code === "42703"
        ? null
        : ((data as { discord_user_id: string | null; role: string | null } | null) ??
          null);
    if (handle?.discord_user_id) {
      await syncMemberRoles(handle.discord_user_id, (handle.role as any) ?? "student");
    }
    const settings = await getDiscordSettings();
    if (settings.adminFeedChannelId) {
      await postChannelMessage(settings.adminFeedChannelId, {
        embeds: [
          announcementEmbed({
            title: `Accepted: ${app.full_name ?? app.applicantName ?? app.applicantEmail ?? "applicant"}`,
            body: `Cohort: ${cohortName}`,
            link: `${env.siteUrl}/admin/applications/${app.id}`,
          }),
        ],
      });
    }
  } catch (err) {
    console.error("[admissions] accept discord sync failed", err);
  }
}

/**
 * What lands in review_notes on an auto-admit.
 *
 * Written into the row rather than left blank because review_notes is what the
 * applicant's dashboard prints as "note from reviewer" — an acceptance with an
 * empty note reads like the reviewer had nothing to say. This says who decided
 * and why.
 */
export const AUTO_ADMIT_NOTE =
  "Admitted automatically — your Founder Pass carries a seat. " +
  "Nothing to wait for; pay your tuition to lock it in.";

/** What autoAdmitOnSubmit() did, so the caller can tell the applicant. */
export type AutoAdmitResult =
  | { admitted: false }
  | { admitted: true; cohortName: string | null; grant: PassGrant };

/**
 * Admit a just-submitted application outright when its author holds a virtual
 * founder pass.
 *
 * Runs INSIDE the submit action rather than as a cron or a webhook, on purpose:
 * the promise on the invite is "submit and you're in", and a holder who reloads
 * their dashboard three seconds later must already see the acceptance. A queued
 * job would make the promise true eventually and false at exactly the moment
 * it's read.
 *
 * The status write is conditional on `status = 'submitted'` so it can only ever
 * move an application the caller just created. Two racing submits, or a submit
 * landing after an admin has already decided, resolve to zero rows updated and
 * this returns "not admitted" — the admin's decision stands, and nobody gets
 * two acceptance emails.
 *
 * Deliberately does NOT check cohort capacity: nothing else in the product does
 * (an admin accepting their 25th student into a 24-seat cohort is not stopped
 * either), and inventing a silent cap here would make the perk fail in a way
 * the holder couldn't see or fix. Capacity is an admin conversation, not a
 * surprise rejection.
 *
 * It DOES stop at a human decline — see reviewerOverrodePass() in
 * lib/reapply.ts, which is also what /apply's banner consults so the page and
 * the action can't promise different things.
 */
export async function autoAdmitOnSubmit(
  admin: SupabaseClient,
  args: { applicationId: string; userId: string },
): Promise<AutoAdmitResult> {
  const pass = await getPassForUser(admin, args.userId);
  if (!pass || !grantAutoAdmits(pass.grant)) return { admitted: false };
  const grant = pass.grant;

  if (await overriddenByReviewer(admin, args.userId, pass.redeemedAt)) {
    return { admitted: false };
  }

  const { data: updated, error } = await admin
    .from("applications")
    .update({
      status: "accepted",
      reviewed_at: new Date().toISOString(),
      review_notes: AUTO_ADMIT_NOTE,
    })
    .eq("id", args.applicationId)
    .eq("status", "submitted")
    .select(
      "id, user_id, full_name, cohort:cohorts(name, price_cents), profile:profiles!applications_user_id_fkey(email, full_name)",
    )
    .maybeSingle();

  // A failure here is a seat NOT granted, which the caller has to be able to
  // report — but it must not fail the submission itself. The application is
  // saved and sitting in the queue; the worst case is that an admin accepts it
  // by hand, which is the pre-perk behaviour.
  if (error) {
    console.error("[admissions] auto-admit write failed", error);
    return { admitted: false };
  }
  if (!updated) return { admitted: false };

  const row = updated as any;
  const cohort = Array.isArray(row.cohort) ? row.cohort[0] : row.cohort;
  const profile = Array.isArray(row.profile) ? row.profile[0] : row.profile;

  // System actor (null), not the applicant: they did not decide this, their
  // pass did. An audit row attributed to the person it admitted would be
  // useless the one time it matters.
  await logAuditMany(null, [
    {
      action: "application.auto_accepted",
      targetType: "application",
      targetId: args.applicationId,
      payload: {
        reason: "founder_pass_virtual",
        tier: grant.tier.key,
        user_id: args.userId,
      },
    },
  ]);

  await announceAcceptance(
    admin,
    {
      id: row.id,
      user_id: row.user_id,
      full_name: row.full_name ?? null,
      cohortName: cohort?.name ?? null,
      listPriceCents: cohort?.price_cents ?? 13000,
      applicantEmail: profile?.email ?? null,
      applicantName: row.full_name ?? profile?.full_name ?? null,
    },
    grant,
  );

  return { admitted: true, cohortName: cohort?.name ?? null, grant };
}

/**
 * Has a reviewer already declined this person SINCE they got the pass?
 *
 * This is the one thing that can switch the auto-admit off, and it exists
 * because two features that are each correct collide badly without it. A
 * declined applicant may reapply — a pass holder may even go straight back at
 * the cohort that declined them (lib/reapply.ts, rule 3). And a virtual pass
 * admits on submit. Composed naively, that means an admin who deliberately
 * declines a pass holder watches the application reappear as "accepted"
 * seconds later, with no way to make the no stick short of revoking the pass.
 *
 * The cut is the REDEMPTION TIME, not merely "have they ever been declined":
 *
 *   - Declined in the spring, handed a virtual pass in the summer → the pass
 *     was issued knowing that history, and is the invitation that supersedes
 *     it. Auto-admit stands.
 *   - Holding the pass, applied, declined by a human → that reviewer looked at
 *     this person WITH the pass in hand and still said no. The next
 *     application goes back through the queue, which is what "you can apply
 *     again" has always meant. Their priority lane, feedback and rebuild all
 *     still apply; only the automatic seat does not.
 *
 * Fails CLOSED — a read error, or a pass with no redemption timestamp,
 * resolves to "overridden" and the application goes through review. The cost
 * of being wrong in that direction is a short wait; in the other, it is a seat
 * handed out over a reviewer's explicit objection.
 */
/**
 * reviewerOverrodePass() against a fresh read of the user's declined
 * applications. The rule itself lives in lib/reapply.ts (pure, and tested
 * there); this is only the query that feeds it.
 *
 * Fails closed on a read error, matching the predicate's own posture — if we
 * can't see the history, we don't hand out a seat.
 */
async function overriddenByReviewer(
  admin: SupabaseClient,
  userId: string,
  redeemedAt: string | null,
): Promise<boolean> {
  if (!redeemedAt) return true;
  const { data, error } = await admin
    .from("applications")
    .select("status, reviewed_at")
    .eq("user_id", userId)
    .eq("status", "rejected");
  if (error) {
    console.error("[admissions] auto-admit override check failed", error);
    return true;
  }
  return reviewerOverrodePass((data ?? []) as DecidedApplication[], redeemedAt);
}
