"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { MAX_AUDIENCE } from "@/lib/email/audience";
import {
  resolveSmsAudience,
  UNREACHABLE_LABELS,
  type UnreachableReason,
} from "@/lib/sms/audience";
import { CONSENT_COPY, grantConsent } from "@/lib/sms/consent";
import { env } from "@/lib/env";
import {
  MAX_SEGMENTS,
  enqueueSms,
  sendSms,
  smsTransportStatus,
  type SmsResult,
} from "@/lib/sms/send";
import { countSegments } from "@/lib/sms/segments";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";
import { describeDelay, nextAllowedSend } from "@/lib/sms/quiet-hours";
import { isSmsAudienceSegment, type SmsAudienceSegment } from "@/lib/sms/policy";
import { formatE164, maskE164, normalizeToE164 } from "@/lib/phone";

/**
 * The three things the campaign composer is allowed to ask the server for:
 * how many people it would reach, one real test text, and the send itself.
 *
 * Every one of them re-derives the audience from the segment name. The browser
 * names a GROUP; it never names a person and never sees a number. That is the
 * same rule sendBlast() follows for email addresses, and it matters more here:
 * a tampered request that could hand us a recipient list would be a
 * $500-per-message liability generator, not merely an unwanted email.
 *
 * Every campaign is a program text to students' own numbers. There is no
 * purpose for the browser to pick: lib/sms/policy.ts allows nothing else, and
 * the transport and the drain refuse anything else even if a row asked.
 */

const PURPOSE = "transactional" as const;

/** What the composer picks. */
export type SmsAudienceInput = {
  segment: SmsAudienceSegment;
  cohortId?: string | null;
};

export type SmsAudiencePreview = {
  /** Distinct numbers that would actually receive this, after consent + dedupe. */
  reachable: number;
  counts: Record<UnreachableReason, number>;
  /**
   * The wording for those counts, shipped WITH them rather than imported by the
   * composer. UNREACHABLE_LABELS lives beside the code that assigns the reasons,
   * in a module that pulls in the Supabase admin client — importing it from a
   * client component would drag that into the browser bundle.
   */
  labels: Record<UnreachableReason, string>;
  /** True when the audience hit MAX_AUDIENCE and was truncated. */
  truncated: boolean;
  quiet: {
    startHour: number;
    endHour: number;
    /** How many reachable numbers are outside their own window right now. */
    deferred: number;
    /** describeDelay() for the soonest deferred send, in that recipient's zone. */
    firstSendLabel: string | null;
  };
};

export type SmsAudienceResult =
  | { ok: true; preview: SmsAudiencePreview }
  | { ok: false; error: string };

function specFor(input: SmsAudienceInput) {
  return { segment: input.segment, cohortId: input.cohortId || null };
}

/**
 * Counts, never numbers.
 *
 * The composer needs to know how many people it can reach and why the rest fall
 * out. It does not need the list, and shipping one would put students' mobiles
 * into a DOM payload for no gain at all, because sendSmsCampaign re-resolves the
 * audience server-side and would ignore a client list if it were offered one.
 */
export async function previewSmsAudience(input: SmsAudienceInput): Promise<SmsAudienceResult> {
  await assertPermission("sms.send");
  if (!isSmsAudienceSegment(input.segment)) {
    return { ok: false, error: "Unknown audience." };
  }

  const [audience, settings] = await Promise.all([
    resolveSmsAudience(specFor(input)),
    getSmsSettings(),
  ]);

  // Quiet hours, evaluated against the REAL numbers rather than the admin's own
  // clock. An operator in New Jersey composing at 8:30pm Eastern is inside the
  // window for themselves and outside it for every Pacific number in the list;
  // the honest answer is per-recipient, and it is only computable here.
  const now = new Date();
  let deferred = 0;
  let soonest: { at: Date; phone: string } | null = null;
  for (const r of audience.recipients) {
    const allowedAt = nextAllowedSend(r.phone, settings.quietHours, now);
    // A null means the configured window can never be satisfied for this number.
    // Counted as deferred so the panel doesn't claim it sends now; the drain will
    // hold the row with a readable reason.
    if (!allowedAt || allowedAt.getTime() > now.getTime()) {
      deferred++;
      if (allowedAt && (!soonest || allowedAt.getTime() < soonest.at.getTime())) {
        soonest = { at: allowedAt, phone: r.phone };
      }
    }
  }

  return {
    ok: true,
    preview: {
      reachable: audience.recipients.length,
      counts: audience.counts,
      labels: UNREACHABLE_LABELS,
      truncated: audience.recipients.length >= MAX_AUDIENCE,
      quiet: {
        startHour: settings.quietHours.startHour,
        endHour: settings.quietHours.endHour,
        deferred,
        firstSendLabel: soonest ? describeDelay(soonest.phone, soonest.at) : null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

/** Attribution on every outbox row a campaign creates. */
const CAMPAIGN_TEMPLATE_KEY = "sms.campaign";

export type CampaignInput = {
  /** Internal label. Never sent to anyone; it names the row on the outbox page. */
  name: string;
  body: string;
  segment: SmsAudienceSegment;
  cohortId?: string | null;
  /**
   * ISO instant, resolved in the browser from a `datetime-local` value. Empty or
   * absent means "as soon as the next drain runs".
   */
  sendAt?: string;
  /**
   * Idempotency key, generated once per composed draft in the browser.
   *
   * It is what makes the dedupe key stable across submits. Without it every
   * submit mints a fresh campaign id, `campaign:<id>:<phone>` is unique by
   * construction, and a double-clicked send bills twice — the unique index on
   * sms_outbox.dedupe_key can only collapse rows whose keys actually match.
   * sms_campaigns.client_key is unique too (0106), so two racing submits of
   * one draft land on one campaign row.
   */
  clientKey: string;
};

export type CampaignResult =
  | {
      ok: true;
      campaignId: string;
      /** Echoed so the success notice can't drift if the field is edited after. */
      name: string;
      /** Rows newly parked in the outbox. */
      queued: number;
      /** Recipients already parked under this draft — i.e. this was a re-submit. */
      duplicate: number;
      failed: number;
      errors: string[];
      segmentsPerMessage: number;
      estimatedRecipients: number;
    }
  | { ok: false; error: string };

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The campaign row for this draft: the existing one, or a new one.
 *
 * Insert first and fall back to a lookup on the unique-violation, rather than
 * look up first and insert on a miss: the lookup-first order is a race two
 * clicks a few milliseconds apart can both win, and the unique index on
 * client_key is what closes it.
 */
async function campaignForDraft(row: {
  clientKey: string;
  name: string;
  body: string;
  audience: Record<string, unknown>;
  segments: number;
  recipients: number;
  createdBy: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("sms_campaigns")
    .insert({
      client_key: row.clientKey,
      name: row.name,
      body: row.body,
      purpose: PURPOSE,
      audience: row.audience,
      segments_per_message: row.segments,
      recipients: row.recipients,
      status: "queued",
      created_by: row.createdBy,
    })
    .select("id")
    .maybeSingle();
  if (!error && created?.id) return { ok: true, id: created.id as string };
  if (error && (error as { code?: string }).code !== "23505") {
    return { ok: false, error: error.message };
  }
  const { data: prior, error: priorError } = await admin
    .from("sms_campaigns")
    .select("id")
    .eq("client_key", row.clientKey)
    .maybeSingle();
  if (priorError) return { ok: false, error: priorError.message };
  if (!prior?.id) return { ok: false, error: "Campaign insert returned no row." };
  return { ok: true, id: prior.id as string };
}

/**
 * Queue a campaign.
 *
 * ALWAYS queues, never sends inline. A 300-recipient blast at the ~350ms of
 * spacing a toll-free number is provisioned for takes nearly two minutes of
 * provider calls; making an admin's click wait for that means the request dies
 * halfway and nobody can say which half went out. The outbox plus
 * /api/cron/sms-queue already solve this, and the drain is also where consent and
 * quiet hours get their final, latest-possible check.
 */
export async function sendSmsCampaign(input: CampaignInput): Promise<CampaignResult> {
  const { userId } = await assertPermission("sms.send");

  const name = input.name.trim();
  const body = input.body.trim();
  if (!name) return { ok: false, error: "Give the campaign a name." };
  if (!body) return { ok: false, error: "The message is empty." };
  if (!isSmsAudienceSegment(input.segment)) {
    return { ok: false, error: "Unknown audience." };
  }
  if (!CLIENT_KEY_PATTERN.test(input.clientKey ?? "")) {
    return { ok: false, error: "Missing draft key — reload the page and recompose." };
  }

  const segments = countSegments(body);
  if (segments > MAX_SEGMENTS) {
    return {
      ok: false,
      error: `${segments} segments (max ${MAX_SEGMENTS}). Shorten the message or remove the characters forcing UCS-2.`,
    };
  }

  // The scheduled instant, floored at now. A time in the past is not an error —
  // it is an admin who took ninety seconds to confirm — and the drain treats
  // "due" and "overdue" identically anyway.
  const now = new Date();
  let base = now;
  if (input.sendAt) {
    const at = new Date(input.sendAt);
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: "That send time isn't a real date." };
    }
    if (at.getTime() > now.getTime()) base = at;
  }

  // Re-resolve server-side. The browser named a segment; the numbers come from
  // the database, now — a tampered request must not be able to choose who we
  // text.
  const [audience, settings] = await Promise.all([
    resolveSmsAudience(specFor(input)),
    getSmsSettings(),
  ]);

  // Inert means inert here too, not only on the page. The composer is hidden
  // until credentials exist, but a tab left open from before they were
  // cleared, or a direct POST from anyone holding sms.send, would otherwise
  // park real rows — and the day someone saves credentials, the next drain
  // would send that stale campaign at once. Same refusal as sendSms. (Paused
  // is allowed: parking is what the pause switch means.)
  if (!settings.configured || settings.readError || !hasCredentials(settings)) {
    const transport = await smsTransportStatus();
    return { ok: false, error: `Texting isn't sending yet — ${transport.detail}` };
  }

  if (audience.recipients.length === 0) {
    const blocked = Object.values(audience.counts).reduce((a, b) => a + b, 0);
    return {
      ok: false,
      error:
        blocked === 0
          ? "Nobody is in that audience."
          : `Nobody in that audience has a textable number with texts turned on (${blocked} blocked). Ask them to opt in from Collect numbers.`,
    };
  }

  const admin = createAdminClient();

  // ---- the campaign row ---------------------------------------------------
  // Written FIRST, because every queued row carries its id and a failed insert
  // must mean nothing was spent.
  const campaign = await campaignForDraft({
    clientKey: input.clientKey,
    name,
    body,
    audience: {
      segment: input.segment,
      cohortId: input.cohortId || null,
      // Kept verbatim so a send stays explainable after the segment
      // definitions change — the reason sms_campaigns.audience is jsonb.
      resolvedAt: now.toISOString(),
      resolved: audience.recipients.length,
      unreachable: audience.counts,
    },
    segments,
    recipients: audience.recipients.length,
    createdBy: userId,
  });
  if (!campaign.ok) return { ok: false, error: campaign.error };
  const campaignId = campaign.id;

  // Which numbers are already parked under this campaign. Empty for a fresh one;
  // on a re-submit it is exactly the set the unique index would reject, and
  // reading it means we can report "already queued" as a fact rather than
  // pattern-matching the transport's error prose.
  const alreadyQueued = new Set<string>();
  const { data: existingRows } = await admin
    .from("sms_outbox")
    .select("to_phone")
    .eq("campaign_id", campaignId)
    .limit(5000);
  for (const row of (existingRows ?? []) as { to_phone: string }[]) {
    alreadyQueued.add(row.to_phone);
  }

  // ---- park one row per recipient ----------------------------------------
  // Through enqueueSms rather than one bulk insert: it owns the normalization,
  // the segment stamping and the dedupe-collision handling, and a bespoke bulk
  // insert here would be a second copy of all three that drifts. At this
  // program's scale the round trips are the cheaper half of that trade, and the
  // page's maxDuration is set with them in mind.
  let queued = 0;
  let duplicate = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const r of audience.recipients) {
    if (alreadyQueued.has(r.phone)) {
      duplicate++;
      continue;
    }
    // Stamp the polite instant now so the outbox reads honestly instead of
    // showing three hundred rows all claiming to be due immediately. The drain
    // re-evaluates this anyway (a row queued inside the window can come due
    // outside it), so this is a better starting point, not a substitute.
    const sendAfter = nextAllowedSend(r.phone, settings.quietHours, base) ?? base;
    const result = await enqueueSms({
      to: r.phone,
      body,
      purpose: PURPOSE,
      templateKey: CAMPAIGN_TEMPLATE_KEY,
      userId: r.userId,
      toName: r.name,
      party: r.party,
      campaignId,
      dedupeKey: `campaign:${campaignId}:${r.phone}`,
      sendAfter,
      segments,
    });
    if (result.ok) {
      queued++;
    } else {
      failed++;
      if (errors.length < 5) errors.push(result.error);
    }
  }

  // The row's `recipients` describes what was actually parked. sent/failed stay
  // at zero here — the drain recounts them from the outbox, which is what keeps
  // the counters from drifting away from the rows.
  //
  // `name` is written again because the draft key only tracks CONTENT: renaming a
  // campaign and re-submitting reuses the same row, and the label on the outbox
  // page should be the one the operator last typed.
  await admin
    .from("sms_campaigns")
    .update({
      name,
      recipients: queued + duplicate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  // Audited before the failure branch below, and with the counts either way: a
  // campaign row exists and money was almost spent, which is exactly the event an
  // audit trail is for.
  await logAudit({
    action: "sms.campaign_sent",
    targetType: "sms_campaign",
    targetId: campaignId,
    payload: {
      name,
      purpose: PURPOSE,
      segment: input.segment,
      cohortId: input.cohortId || null,
      segmentsPerMessage: segments,
      resolved: audience.recipients.length,
      unreachable: audience.counts,
      queued,
      duplicate,
      failed,
      sendAfter: base.toISOString(),
    },
  });

  // Nothing parked and nothing already parked is a failure, not a quiet success.
  // "Queued 0 texts" is the kind of line an operator reads as "done".
  if (queued === 0 && duplicate === 0) {
    return {
      ok: false,
      error: `Nothing could be queued${errors.length > 0 ? `: ${errors.join("; ")}` : "."}`,
    };
  }

  revalidatePath("/admin/sms/outbox");

  return {
    ok: true,
    campaignId,
    name,
    queued,
    duplicate,
    failed,
    errors,
    segmentsPerMessage: segments,
    estimatedRecipients: audience.recipients.length,
  };
}

// ---------------------------------------------------------------------------
// The test send
// ---------------------------------------------------------------------------

export type TestSendOutcome =
  | {
      ran: true;
      /** Formatted echo of what the typed number normalized to. */
      to: string;
      /** The transport's verdict, verbatim. */
      result: SmsResult;
      /**
       * Did the text reach the provider — or is it held by quiet hours, to go
       * out through the same drain in the morning? That is what unlocks the
       * composer. A refusal of any kind, or a test parked by the pause switch,
       * proves nothing about the campaign: the provider was never called and
       * nothing will call it, so the credentials, the sending number and the
       * copy on a real screen are all still untested.
       */
      chainProven: boolean;
    }
  | { ran: false; error: string };

/**
 * Send the real message to one number, through the real transport.
 *
 * No dedupe key, so testing the same copy twice actually sends twice — a test
 * that silently collapses into a previous one is the opposite of a test.
 *
 * The test goes through the same consent gate as everything else. A number
 * reaches it one of two ways: it turned texts on at /dashboard/phone like any
 * student, or — the usual case, because staff have no application — the admin
 * ticks "this is my own phone" (`ownNumber`), which records their agreement in
 * the consent ledger exactly as a student's is recorded, with CONSENT_COPY's
 * sentence, their account, IP and browser. That grant is refused for a number
 * on anyone else's application (numberIsAnotherApplicants, below) or already
 * on file as a student's, can't lift anybody's opt-out
 * (lib/sms/consent-rules.ts), and never reaches a campaign: audiences only
 * count a student's own opt-in (campaignMayText). A refusal is returned
 * verbatim, because the reason IS the useful part.
 */
/**
 * Is `e164` the number on someone else's application? True, false, or null when
 * the check itself failed (the caller refuses on null: fail closed).
 *
 * Applications store the number as typed, so it can't be matched with an
 * equality filter. Every way of typing a number that normalizes to `e164`
 * contains its last seven digits in order, so `ilike` on those digits with
 * wildcards between them is a superset of the matches; normalizeToE164 on each
 * candidate is the exact test. The admin's own application, if they have one,
 * doesn't count.
 */
async function numberIsAnotherApplicants(e164: string, userId: string): Promise<boolean | null> {
  const tail = e164.replace(/\D/g, "").slice(-7);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("applications")
    .select("user_id, phone")
    .ilike("phone", `%${tail.split("").join("%")}%`)
    .limit(1000);
  if (error) {
    console.error("[sms/blast] applicant number check failed", error.message);
    return null;
  }
  return ((data ?? []) as { user_id: string | null; phone: string | null }[]).some(
    (r) => r.user_id !== userId && normalizeToE164(r.phone) === e164,
  );
}

export async function sendTestSms(
  phone: string,
  body: string,
  ownNumber: boolean,
): Promise<TestSendOutcome> {
  const { userId } = await assertPermission("sms.send");

  const to = normalizeToE164(phone);
  if (!to) {
    return { ran: false, error: "That isn't a number we can read. Try 10 digits." };
  }
  const text = body.trim();
  if (!text) return { ran: false, error: "The message is empty." };

  const segments = countSegments(text);
  if (segments > MAX_SEGMENTS) {
    return {
      ran: false,
      error: `${segments} segments (max ${MAX_SEGMENTS}). Shorten it before testing.`,
    };
  }

  if (ownNumber) {
    // A student's number with no opt-in yet has no consent row, so the consent
    // rules alone can't see that it is theirs. The application can.
    const theirs = await numberIsAnotherApplicants(to, userId);
    if (theirs !== false) {
      return {
        ran: false,
        error:
          theirs === null
            ? "Couldn't check whether that number belongs to a student, so it wasn't opted in. Try again."
            : "That number is on a student's application, so it can't be opted in as your own phone. Test on a phone that is yours.",
      };
    }
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    const granted = await grantConsent({
      phone: to,
      userId,
      party: "unknown",
      purposes: [PURPOSE],
      consentText: CONSENT_COPY.adminTest,
      source: "admin_test",
      sourceUrl: `${env.siteUrl}/admin/sms/blast`,
      ip: fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip"),
      userAgent: h.get("user-agent"),
    });
    if (!granted.ok) return { ran: false, error: granted.error };
  }

  const result = await sendSms({
    to,
    body: text,
    purpose: PURPOSE,
    templateKey: `${CAMPAIGN_TEMPLATE_KEY}_test`,
  });

  // Sent; or held by quiet hours, which will send this test in the morning
  // through the same drain, credentials and window the campaign's own rows
  // will meet — and an evening campaign is held to the same morning anyway.
  // NOT parked by the pause switch: that never reaches the provider and says
  // nothing about the credentials, the number or the copy.
  const chainProven = result.ok || result.queuedReason === "quiet_hours";

  await logAudit({
    action: "sms.campaign_test_sent",
    targetType: "sms_outbox",
    targetId: result.outboxId ?? null,
    payload: {
      // Masked, like every other SMS admin surface. The full number is already on
      // the outbox row this entry points at, and the audit log is the widest-read
      // table in the admin area — a second copy of a real mobile buys nothing.
      to: maskE164(to),
      ownNumberOptIn: ownNumber,
      segments: result.segments ?? segments,
      ok: result.ok,
      reason: result.reason ?? null,
    },
  });

  return { ran: true, to: formatE164(to), result, chainProven };
}
