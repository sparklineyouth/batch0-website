// ---------------------------------------------------------------------------
// The #staff feed's lines: what postStaffFeed (lib/chat-post.ts) says when
// something happens elsewhere on the site.
//
// #staff is read by everyone with chat.manage, and that is not the permission
// that guards applications, payments or fines. So a line says who and what
// happened and links to the admin page that holds the rest behind its own
// permission. It never carries an email address, an amount or a refund
// reason: the builders below don't take one.
//
// Pure and import-free, so `node --test` runs it as is.
// ---------------------------------------------------------------------------

/**
 * A person as the feed names them: their name, or the fallback. Never their
 * email. profiles.full_name defaults to '' (0001), and a name that is an email
 * address is still an email address.
 */
export function feedName(name: string | null | undefined, fallback: string): string {
  const n = (name ?? "").trim();
  return n && !n.includes("@") ? n : fallback;
}

export function applicationLine(a: {
  name: string | null | undefined;
  applicationId: string;
  autoAdmitted: boolean;
  siteUrl: string;
}): string {
  return `${a.autoAdmitted ? "Auto-admitted by founder pass" : "New application"}: **${feedName(a.name, "an applicant")}** · ${a.siteUrl}/admin/applications/${a.applicationId}`;
}

export function acceptedLine(a: {
  name: string | null | undefined;
  cohortName: string;
  applicationId: string;
  siteUrl: string;
}): string {
  return `Accepted: **${feedName(a.name, "an applicant")}** into ${a.cohortName} · ${a.siteUrl}/admin/applications/${a.applicationId}`;
}

/** A paid seat (lib/stripe-fulfillment.ts): what Discord's enrollment post was. */
export function enrolledLine(a: {
  name: string | null | undefined;
  cohortName: string;
  userId: string;
  siteUrl: string;
}): string {
  return `Enrolled: **${feedName(a.name, "a student")}** in ${a.cohortName} · ${a.siteUrl}/admin/students/${a.userId}`;
}

/** A fine or fee refunded. The amount and the reason stay on /admin/charges. */
export function chargeRefundedLine(a: {
  name: string | null | undefined;
  kind: "fine" | "fee";
  userId: string;
  siteUrl: string;
}): string {
  return `${a.kind === "fine" ? "Fine" : "Fee"} refunded to **${feedName(a.name, "a student")}** · ${a.siteUrl}/admin/charges?user=${a.userId}`;
}

/** An enrollment payment refunded. The amount and the reason stay on /admin/payments. */
export function paymentRefundedLine(a: { name: string | null | undefined; siteUrl: string }): string {
  return `Enrollment payment refunded to **${feedName(a.name, "a student")}** · ${a.siteUrl}/admin/payments`;
}

export function feedbackCreditLine(a: { name: string | null | undefined; topic: string; siteUrl: string }): string {
  return `Feedback credit redeemed by **${feedName(a.name, "a pass holder")}** on ${a.topic} · ${a.siteUrl}/admin/passes#requests`;
}

export function rebuildLine(a: { name: string | null | undefined; siteUrl: string }): string {
  return `Seven-day rebuild submitted by **${feedName(a.name, "a pass holder")}**: queued for one fresh review · ${a.siteUrl}/admin/applications`;
}

export function challengeEntryLine(a: {
  name: string | null | undefined;
  challengeTitle: string;
  challengeId: string;
  submissionId: string;
  siteUrl: string;
}): string {
  return `🏆 New **${a.challengeTitle}** submission from ${feedName(a.name, "an entrant")} · ${a.siteUrl}/admin/challenges/${a.challengeId}/submissions/${a.submissionId}`;
}
