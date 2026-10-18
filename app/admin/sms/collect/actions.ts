"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { getMissingSmsConsent, type MissingConsentRow } from "@/lib/sms/audience";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";

const TEMPLATE_KEY = "sms.opt_in_request";

// Same ceiling as every other audience send in the admin. This one resolves to
// the accepted-and-enrolled roster, so it will never come close — the guard is
// here so a future widening of the audience trips it instead of mailing 5,000
// people.
const MAX_RECIPIENTS = 1000;

export type CollectRow = MissingConsentRow;

export type CollectWorklist = {
  /** Least reachable first — see `reachabilityScore` for what that means. */
  rows: CollectRow[];
  /** Roster size: everyone accepted, paid or enrolled. */
  total: number;
  /** Students whose own number could take a program text right now. */
  textable: number;
  /** Rows the opt-in email would go to — see `askable`. */
  pending: number;
  /**
   * People who still owe us an opt-in and have no deliverable address, so this
   * page cannot ask them. Surfaced rather than quietly dropped: it is the one
   * number here that no button can move.
   */
  unaskable: number;
};

/**
 * How reachable is this person, on a 0–3 scale.
 *
 * Consent is worth more than a number because a number without consent is
 * something an admin can only wait for, while no number at all is something
 * this page's email can act on. Sorting ascending therefore puts the rows the
 * operator can actually move to the top.
 */
function reachabilityScore(r: CollectRow): number {
  return (r.hasNumber ? 1 : 0) + (r.consent ? 2 : 0);
}

/**
 * Would the opt-in email ask this person for something they can give?
 *
 * Not someone already opted in, and not someone who opted OUT — emailing a
 * person who told us to stop texting them to ask them to start again is the
 * re-marketing an opt-out exists to prevent. Not an under-13 either: the page
 * the email links to won't offer them texts (lib/sms/policy.ts).
 */
function needsAsking(r: CollectRow): boolean {
  return !r.consent && !r.optedOut && !r.underAge;
}

/** Is this someone the opt-in email can actually reach? */
function askable(r: CollectRow): boolean {
  return needsAsking(r) && !isPlaceholderEmail(r.email);
}

/**
 * The worklist behind /admin/sms/collect.
 *
 * Thin wrapper over getMissingSmsConsent: it adds the permission check (the lib
 * function is a plain query with none, so every caller states its own bar), the
 * ordering, and the numbers in the summary line.
 *
 * People with a placeholder address stay in `rows` and in `total`. They are on
 * the roster and unreachable, and dropping them would make the summary claim a
 * better reachability ratio than we have. They're excluded from the send only.
 */
export async function loadCollectWorklist(): Promise<
  { ok: true; worklist: CollectWorklist } | { ok: false; error: string }
> {
  // `sms.send`, matching ADMIN_ROUTE_PERMISSIONS for /admin/sms/collect.
  await assertPermission("sms.send");

  const res = await getMissingSmsConsent();
  if (!res.ok) return { ok: false, error: res.error };

  const sorted: CollectRow[] = [...res.rows].sort((a, b) => {
    const byScore = reachabilityScore(a) - reachabilityScore(b);
    if (byScore !== 0) return byScore;
    // Enrolled before accepted at equal reachability: they've paid, so a
    // schedule change they miss is a refund conversation, not a lost lead.
    if (a.status !== b.status) return a.status === "enrolled" ? -1 : 1;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });

  return {
    ok: true,
    worklist: {
      rows: sorted,
      total: sorted.length,
      textable: sorted.filter((r) => r.consent).length,
      pending: sorted.filter(askable).length,
      unaskable: sorted.filter((r) => needsAsking(r) && !askable(r)).length,
    },
  };
}

export type OptInRequestResult =
  | { ok: true; sent: number; failed: { to: string; reason: string }[] }
  | { ok: false; error: string };

/**
 * Email everyone still missing an opt-in, pointing them at /dashboard/phone.
 *
 * This is EMAIL. It has to be: texting someone to ask whether we may text them
 * is the thing consent exists to prevent, and email is the only channel that
 * reaches a roster with almost no opted-in numbers.
 *
 * Refused until texting is live. An email asking "can we text you?" when no
 * sending number exists yet is a promise we can't keep, and the people who
 * answered it would wait weeks for a first text that explains nothing. The
 * opt-in page itself is up regardless — it has to be, for the carrier to review
 * it — but nothing points people at it before there is something to opt into.
 *
 * Re-resolves the audience server-side — the browser passes nothing, so a page
 * left open overnight can't widen the send or redirect it at an address that
 * has since changed.
 */
export async function sendSmsOptInRequests(): Promise<OptInRequestResult> {
  await assertPermission("sms.send");

  const settings = await getSmsSettings();
  if (!settings.configured || settings.readError || !hasCredentials(settings)) {
    return {
      ok: false,
      error:
        "Texting isn't live yet, so there's nothing to opt into. Add the sending number and credentials at /admin/sms/settings first.",
    };
  }

  const res = await loadCollectWorklist();
  if (!res.ok) return { ok: false, error: res.error };

  const recipients = res.worklist.rows.filter(askable);
  if (recipients.length === 0) {
    // Two very different nothings, and conflating them would have an operator
    // believe the roster is done when in fact nobody can be asked.
    return {
      ok: false,
      error:
        res.worklist.unaskable > 0
          ? `Nobody left to email. The ${res.worklist.unaskable} still missing an opt-in have no deliverable address.`
          : "Everyone we can ask has already answered.",
    };
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: `That resolves to ${recipients.length} recipients. Max ${MAX_RECIPIENTS} per send.`,
    };
  }

  const items = recipients.map((r) => {
    const t = Templates.smsOptIn({ name: r.name });
    return {
      to: r.email,
      subject: t.subject,
      html: t.html,
      templateKey: TEMPLATE_KEY,
    };
  });

  const results = await sendEmailBatch(items);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ to: r.to, reason: r.reason ?? "unknown" }));
  const sent = results.length - failed.length;

  await logAudit({
    action: "sms.opt_in_request_sent",
    targetType: "email_blast",
    payload: {
      template: TEMPLATE_KEY,
      recipients: recipients.length,
      sent,
      failed: failed.length,
      // Worth recording: it dates the "we had N textable numbers" claim in any
      // later argument about why a campaign only reached a handful of people.
      textable: res.worklist.textable,
    },
  });

  revalidatePath("/admin/sms/collect");
  return { ok: true, sent, failed };
}
