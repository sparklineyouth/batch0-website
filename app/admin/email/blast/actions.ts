"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sendEmail, sendEmailBatch } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import {
  STATUS_RANK,
  buildEnvelopes,
  firstName,
  joinNames,
  personalize,
  pickParentEmail,
  type BlastAudience,
  type BlastVariant,
} from "./shared";

export type BlastDraft = {
  subject: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
};

export type { BlastAudience, BlastVariant };

export type BlastSendResult =
  | {
      ok: true;
      sent: number;
      failed: { to: string; reason: string }[];
    }
  | { ok: false; error: string };

export type BlastRecipient = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Best (furthest-along) application status, or null if never applied. */
  appStatus: string | null;
  /** Names of cohorts the user is enrolled in. */
  cohorts: string[];
  /**
   * Parent / guardian address from their application, if they gave one. The
   * question is optional (and only asked of under-18s), so plenty of people
   * won't have one — the form says so rather than silently dropping them.
   *
   * Display only: sendBlast re-resolves this server-side from the profile id,
   * so a tampered request can't redirect a blast to an arbitrary address.
   */
  parentEmail: string | null;
};

/** The audience presets the form offers. Resolved server-side per pick so
 *  the page never ships the whole directory as props. */
export type BlastSegment =
  | "students"
  | "enrolled"
  | "accepted"
  | "waitlisted"
  | "applied"
  | "everyone";

const SEGMENTS: BlastSegment[] = [
  "students",
  "enrolled",
  "accepted",
  "waitlisted",
  "applied",
  "everyone",
];

// Hard ceiling per blast. Well above any realistic cohort size; exists
// so a bugged "select everyone" click can't turn into a spam cannon.
const MAX_RECIPIENTS = 1000;

/**
 * Server actions can't safely throw (messages are masked in prod), so
 * validation returns a typed result the form renders inline.
 */
function validateDraft(
  draft: BlastDraft,
):
  | { ok: true; subject: string; body: string; cta: { url: string; label: string } | null }
  | { ok: false; error: string } {
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!subject) return { ok: false, error: "Subject is required." };
  if (!body) return { ok: false, error: "Email body is required." };
  const ctaLabel = draft.ctaLabel?.trim();
  const ctaUrl = draft.ctaUrl?.trim();
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl)) {
    return {
      ok: false,
      error: "Button needs both a label and a URL (or leave both empty).",
    };
  }
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) {
    return { ok: false, error: "Button URL must start with http(s)://." };
  }
  return {
    ok: true,
    subject,
    body,
    cta: ctaLabel && ctaUrl ? { label: ctaLabel, url: ctaUrl } : null,
  };
}

/**
 * Resolve one audience segment to displayable recipient rows.
 *
 * Called by the form when the admin picks (or changes) an audience, instead
 * of the page serializing every profile into client props up front. The rows
 * are display/selection only — sendBlast re-resolves addresses from the ids.
 *
 * Only the "students" segment translates to a SQL filter (role = student).
 * The rest key off derived values — best application status, has-enrollment —
 * so they're filtered here after the same mapping the page used to do; the
 * client still only receives the rows in the segment.
 */
export async function getRecipients(
  segment: BlastSegment,
): Promise<
  { ok: true; recipients: BlastRecipient[] } | { ok: false; error: string }
> {
  await assertPermission("email.send");
  if (!SEGMENTS.includes(segment)) {
    return { ok: false, error: "Unknown audience." };
  }

  const admin = createAdminClient();
  let q = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, applications!applications_user_id_fkey(status, parent_email, created_at), enrollments!enrollments_user_id_fkey(cohort:cohorts(name))",
    )
    .order("created_at", { ascending: false })
    .limit(5000);
  if (segment === "students") q = q.eq("role", "student");
  const { data: profiles, error } = await q;
  if (error) return { ok: false, error: error.message };

  const recipients: BlastRecipient[] = (profiles ?? [])
    .filter((p: any) => p.email)
    .map((p: any) => {
      const statuses: string[] = (p.applications ?? []).map(
        (a: any) => a.status,
      );
      const appStatus =
        statuses.length > 0
          ? statuses.reduce((best, s) =>
              (STATUS_RANK[s] ?? -1) > (STATUS_RANK[best] ?? -1) ? s : best,
            )
          : null;
      const cohorts: string[] = (p.enrollments ?? [])
        .map((e: any) =>
          Array.isArray(e.cohort) ? e.cohort[0]?.name : e.cohort?.name,
        )
        .filter(Boolean);
      return {
        id: p.id,
        email: p.email,
        name: p.full_name || null,
        role: p.role,
        appStatus,
        cohorts,
        parentEmail: pickParentEmail(p.applications ?? []),
      };
    })
    .filter((r) => {
      switch (segment) {
        case "enrolled":
          return r.cohorts.length > 0;
        case "accepted":
          return r.appStatus === "accepted";
        case "waitlisted":
          return r.appStatus === "waitlisted";
        case "applied":
          return r.appStatus === "submitted";
        default:
          return true;
      }
    });

  return { ok: true, recipients };
}

/** Render the branded HTML for the live preview pane. */
export async function renderBlastPreview(
  draft: BlastDraft,
  variant: BlastVariant = "student",
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  await assertPermission("email.send");
  const v = validateDraft(draft);
  if (!v.ok) return v;
  const { html } = Templates.blast({
    bodyText:
      variant === "parent"
        ? personalize(v.body, "there", "Alex")
        : personalize(v.body, "Alex", "Alex"),
    preheader: v.subject,
    cta: v.cta,
  });
  return { ok: true, html };
}

/** Send the draft to the signed-in admin only — a real end-to-end test. */
export async function sendTestBlast(
  draft: BlastDraft,
  variant: BlastVariant = "student",
): Promise<{ ok: boolean; message: string }> {
  await assertPermission("email.send");
  const v = validateDraft(draft);
  if (!v.ok) return { ok: false, message: v.error };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, message: "No email on your account." };

  const me = firstName(user.user_metadata?.full_name);
  const { html } = Templates.blast({
    bodyText:
      variant === "parent"
        ? personalize(v.body, "there", me)
        : personalize(v.body, me, me),
    preheader: v.subject,
    cta: v.cta,
  });
  const result = await sendEmail({
    to: user.email,
    subject: `[TEST${variant === "parent" ? " · parent copy" : ""}] ${v.subject}`,
    html,
  });
  return result.ok
    ? { ok: true, message: `Test sent to ${user.email}.` }
    : {
        ok: false,
        message:
          result.reason === "disabled"
            ? "Email is disabled — RESEND_API_KEY isn't set in this environment."
            : `Send failed: ${result.reason}`,
      };
}

/** Send the blast to every selected recipient, personalized per student. */
export async function sendBlast(
  recipientIds: string[],
  draft: BlastDraft,
  audience: BlastAudience = "students",
): Promise<BlastSendResult> {
  const { userId } = await assertPermission("email.send");
  const v = validateDraft(draft);
  if (!v.ok) return v;

  const ids = Array.from(new Set(recipientIds)).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "No recipients selected." };
  if (ids.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: `Too many recipients (${ids.length}). Max ${MAX_RECIPIENTS} per blast.`,
    };
  }

  // Resolve emails server-side from the ids — the client only ever
  // hands us profile ids, so a tampered request can't make us email
  // arbitrary addresses. That includes the parent address: it's re-read
  // from the application here rather than trusted from the form.
  const admin = createAdminClient();
  const people: {
    email: string | null;
    full_name: string | null;
    parentEmail: string | null;
  }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await admin
      .from("profiles")
      .select(
        "email, full_name, applications!applications_user_id_fkey(status, parent_email, created_at)",
      )
      .in("id", ids.slice(i, i + 500));
    if (error) return { ok: false, error: error.message };
    for (const row of (data ?? []) as any[]) {
      people.push({
        email: row.email ?? null,
        full_name: row.full_name ?? null,
        parentEmail: pickParentEmail(row.applications ?? []),
      });
    }
  }

  const envelopes = buildEnvelopes(people, audience);
  if (envelopes.length === 0) {
    return {
      ok: false,
      error:
        audience === "parents"
          ? "None of the selected people have a parent email on their application."
          : "None of the selected recipients have an email.",
    };
  }
  // "Both" can double the address count, so the ceiling is re-checked against
  // what's actually being sent rather than how many people were ticked.
  if (envelopes.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: `That resolves to ${envelopes.length} addresses. Max ${MAX_RECIPIENTS} per blast.`,
    };
  }

  const items = envelopes.map((e) => ({
    to: e.email,
    subject: v.subject,
    html: Templates.blast({
      bodyText: personalize(v.body, e.greet, joinNames(e.students)),
      preheader: v.subject,
      cta: v.cta,
    }).html,
  }));

  const results = await sendEmailBatch(items);
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ to: r.to, reason: r.reason ?? "unknown" }));
  const sent = results.length - failed.length;

  await logAudit({
    action: "email.blast_sent",
    targetType: "email_blast",
    payload: {
      subject: v.subject,
      audience,
      requested: ids.length,
      addresses: envelopes.length,
      parents: envelopes.filter((e) => e.kind === "parent").length,
      sent,
      failed: failed.length,
      sender: userId,
    },
  });

  return { ok: true, sent, failed };
}
