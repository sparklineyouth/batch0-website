import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { normalizeToE164 } from "@/lib/phone";
import { countSegments } from "@/lib/sms/segments";
import { getSmsSettings, hasCredentials, type SmsSettings } from "@/lib/sms/settings";
import { nextAllowedSend } from "@/lib/sms/quiet-hours";
import { providerFor } from "@/lib/sms/providers";
import { isUnsubscribedCode } from "@/lib/sms/providers/twilio";
import {
  canSend,
  revokeConsent,
  type ConsentParty,
  type ConsentPurpose,
} from "@/lib/sms/consent";
import { isPurposeAllowed, PURPOSE_REFUSED } from "@/lib/sms/policy";
import { withFirstMessageDisclosure } from "@/lib/sms/copy";
import { smsWebhookConsoleUrl } from "@/lib/sms/webhook-url";

/**
 * The one place a text leaves the building.
 *
 * Mirrors lib/email/send.ts in shape — a single async function, a result object
 * rather than a throw, a no-op when nothing is configured — because the calling
 * conventions around it should not depend on which channel is being used. The
 * comment at lib/email/dispatch.ts:37 applies here verbatim: a message is a side
 * effect of accepting an applicant or taking a payment, and must never be the
 * reason one of those fails.
 *
 * What is NOT like email: four gates run before the provider is touched, and
 * every one of them is closed by default.
 *
 *   1. configured + not paused + credentials present
 *   2. consent for this number AND this purpose (lib/sms/consent.ts) — and the
 *      purpose has to be one the policy allows at all, which today means
 *      program texts only (lib/sms/policy.ts)
 *   3. quiet hours in the recipient's own timezone — which DEFERS rather than
 *      refuses, because a 2am password-reset text should arrive at 9am, not
 *      never
 *   4. segment ceiling, so a pasted essay is a readable error and not a
 *      four-figure invoice
 *
 * Gate 2 runs here rather than only at enqueue time on purpose. Consent can be
 * revoked in the minutes between a campaign being queued and a row being
 * drained, and a suppression list that doesn't apply to messages already in
 * flight is not a suppression list.
 */

export type SmsResult = {
  ok: boolean;
  reason?: string;
  /** Provider message SID, when it actually went out. */
  id?: string;
  /** Set when quiet hours or the pause switch parked this in the outbox instead of sending. */
  queuedFor?: string;
  /**
   * Which of the two parked it. The composer's test gate needs the difference:
   * a test held for quiet hours goes out in the morning exactly as the
   * campaign's own rows will, but a test parked by the pause switch proves
   * nothing about anything.
   */
  queuedReason?: "quiet_hours" | "paused";
  outboxId?: string;
  segments?: number;
};

/**
 * Hard ceiling on one message.
 *
 * Six segments is ~900 GSM-7 characters — far past the point where a text stops
 * being read. The limit exists because the composer bills per segment and a
 * paste from a doc is the realistic way a 40-segment message gets sent to 300
 * people. Rejecting is right: there is no version of that send that was
 * intended.
 */
export const MAX_SEGMENTS = 6;

/**
 * Attempts before the drain stops retrying a row. Re-exported by
 * lib/sms/queue.ts, whose retry ladder it governs; defined here because a
 * direct send's outbox row is written here and must be born at the cap (see
 * recordSend).
 *
 * The webhook needs the SAME ceiling: a row failed by a carrier receipt has
 * never been through the drain's finish(), so it must be pushed to the cap
 * there or the retry pass treats a permanent failure as a fresh row.
 */
export const MAX_ATTEMPTS = 3;

export type SendSmsArgs = {
  to: string;
  body: string;
  purpose: ConsentPurpose;
  /** Attribution for the metrics page, e.g. "sms.kickoff_reminder". */
  templateKey?: string;
  userId?: string | null;
  toName?: string | null;
  party?: ConsentParty;
  /** Collapses retries of the same logical send into one text. */
  dedupeKey?: string;
  campaignId?: string | null;
};

export type TransportStatus =
  | { ok: true; transport: "sms"; detail: string }
  | { ok: false; transport: "sms"; detail: string };

/**
 * Is SMS actually going to leave the building?
 *
 * Rendered on the settings page. Every SMS feature gates on THIS rather than on
 * `process.env.TWILIO_*`, because every env var on this project is write-only
 * "sensitive" in Vercel and `vercel env pull` returns them as empty strings — so
 * a local env check reports "not configured" on a production site that is
 * sending fine. The credentials live in `sms_settings` instead (docs/sms.md).
 */
export async function smsTransportStatus(): Promise<TransportStatus> {
  const s = await getSmsSettings();
  if (!s.configured) {
    return {
      ok: false,
      transport: "sms",
      detail: "Texting isn't set up yet: migration 0106 hasn't run.",
    };
  }
  if (s.readError) {
    return { ok: false, transport: "sms", detail: `Settings unreadable: ${s.readError}` };
  }
  if (!hasCredentials(s)) {
    const missing = [
      !s.accountSid && "Account SID",
      !s.authToken && "auth token",
      !s.fromNumber && "sending number",
    ].filter(Boolean);
    return {
      ok: false,
      transport: "sms",
      detail: `Missing ${missing.join(", ")}. Add them at /admin/sms/settings.`,
    };
  }
  if (s.smsPaused) {
    return {
      ok: false,
      transport: "sms",
      detail: `Sending is PAUSED. Messages will queue as pending until you resume.`,
    };
  }
  return {
    ok: true,
    transport: "sms",
    detail: `Sending from ${s.fromNumber} via ${s.provider}. Quiet hours ${s.quietHours.startHour}:00–${s.quietHours.endHour}:00 recipient-local.`,
  };
}

/**
 * Where the provider posts delivery receipts. Omitted when there's no https
 * origin. Carries Twilio's retry override (lib/sms/webhook-url.ts), so a
 * receipt the route answered with a 500 — a 21610 suppression it couldn't
 * write — is delivered again instead of dropped. Exported for the drain.
 */
export function statusCallbackUrl(): string | undefined {
  const base = env.siteUrl;
  if (!base.startsWith("https://")) return undefined; // localhost can't receive them
  return smsWebhookConsoleUrl(base);
}

/**
 * Has this number ever received anything from us?
 *
 * CTIA requires the brand name, an opt-out instruction and a rates disclosure in
 * the FIRST message a number receives. Rather than making every call site
 * remember, the transport appends `helpText` once and never again — which also
 * keeps the other 90% of messages short enough to stay in one segment.
 *
 * Exported so lib/sms/queue.ts applies the identical rule. The drain is the path
 * nearly every message actually takes — campaigns always queue, and quiet hours
 * queue transactional messages too — so a disclosure that lived only in this
 * file would be missing from very nearly everything we send.
 */
export async function isFirstMessageTo(phone: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("sms_outbox")
    .select("id", { count: "exact", head: true })
    .eq("to_phone", phone)
    .eq("status", "sent");
  if (error) {
    // Unknown means assume it IS the first: appending the disclosure to a
    // message that didn't need it costs a segment, omitting it from one that did
    // is a compliance miss.
    return true;
  }
  return (count ?? 0) === 0;
}

/**
 * The rule itself is in lib/sms/copy.ts, so the composer's segment preview
 * applies the same one: appended unless the body already names the brand, STOP
 * AND the rates notice — not merely because the word STOP appears somewhere.
 */
export function withDisclosure(body: string, s: SmsSettings, first: boolean): string {
  return withFirstMessageDisclosure(body, s.helpText, first);
}

/**
 * Send now, or queue for the next polite moment.
 *
 * Returns `{ ok: false, reason }` for every refusal rather than throwing, so a
 * caller that ignores the result — which most callers should — degrades to "no
 * text was sent" instead of failing the operation it was reporting on.
 */
export async function sendSms(args: SendSmsArgs): Promise<SmsResult> {
  const to = normalizeToE164(args.to);
  if (!to) return { ok: false, reason: "Not a number we can read." };
  if (!isPurposeAllowed(args.purpose)) return { ok: false, reason: PURPOSE_REFUSED };

  const s = await getSmsSettings();
  if (!s.configured) return { ok: false, reason: "disabled" };
  if (s.readError) {
    // Fail closed: the row carries the quiet-hours window and the pause switch.
    return { ok: false, reason: `Settings unreadable: ${s.readError}` };
  }

  // Gate 2 — consent. Before anything expensive, and before the provider learns
  // the number exists.
  const verdict = await canSend(to, args.purpose);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };

  // Gate 4 — length. Checked before the pause branch so an over-long message is
  // reported while someone is still looking at the composer.
  const segments = countSegments(args.body);
  if (segments > MAX_SEGMENTS) {
    return {
      ok: false,
      reason: `${segments} segments (max ${MAX_SEGMENTS}). Shorten the message or remove emoji.`,
      segments,
    };
  }

  const now = new Date();
  // Gate 3 — quiet hours. Defers, never drops.
  const allowedAt = nextAllowedSend(to, s.quietHours, now);
  if (!allowedAt) {
    return {
      ok: false,
      reason: "The configured quiet-hours window can never be satisfied — check /admin/sms/settings.",
    };
  }

  // No credentials means nothing can ever send, so nothing is parked either.
  // A row queued now would sit until somebody configures a number — weeks,
  // possibly — and then go out describing a session long since over. This is
  // the state the feature ships in, and it must stay inert.
  if (!hasCredentials(s)) return { ok: false, reason: "disabled" };

  const deferred = allowedAt.getTime() > now.getTime();
  const paused = s.smsPaused;

  // Park it. A paused transport parks rather than dropping: that is what makes
  // the pause switch a recovery move instead of a data-loss event, exactly as
  // email_settings.automations_paused behaves. Quiet hours park for the next
  // polite moment in the recipient's own timezone.
  if (deferred || paused) {
    const queued = await enqueueSms({
      ...args,
      to,
      party: args.party ?? verdict.party,
      sendAfter: allowedAt,
      segments,
    });
    if (!queued.ok) return { ok: false, reason: queued.error };
    return {
      ok: false,
      reason: paused ? "Sending is paused — queued." : "Quiet hours — queued.",
      queuedFor: allowedAt.toISOString(),
      queuedReason: paused ? "paused" : "quiet_hours",
      outboxId: queued.id,
      segments,
    };
  }

  const first = await isFirstMessageTo(to);
  const body = withDisclosure(args.body, s, first);
  // The disclosure can push a message over a segment boundary, so re-measure
  // what is actually going on the wire — that is the number we bill against.
  const finalSegments = countSegments(body);

  const provider = providerFor(s);
  const result = await provider.send(
    { to, from: s.fromNumber!, body, statusCallback: statusCallbackUrl() },
    s,
  );

  // Record the attempt either way. An outbox row for a direct send is what makes
  // the admin outbox a complete log rather than a queue-only view, and it is
  // what a delivery receipt joins back to.
  const row = await recordSend({
    ...args,
    to,
    party: args.party ?? verdict.party,
    body,
    segments: finalSegments,
    result,
  });

  if (!result.ok) {
    // Twilio knows about an opt-out we don't — our records have diverged, so
    // write the suppression locally too. Without this, every drain retries a
    // number the carrier will never deliver to.
    if (isUnsubscribedCode(result.errorCode)) {
      await revokeConsent({
        phone: to,
        source: "provider_21610",
        inboundBody: "Provider reported the number as unsubscribed.",
      });
    }
    return { ok: false, reason: result.reason, outboxId: row ?? undefined, segments: finalSegments };
  }
  return { ok: true, id: result.providerId, outboxId: row ?? undefined, segments: finalSegments };
}

/**
 * Write the terminal row for a direct (non-queued) send. Best-effort.
 *
 * A failed direct send is written AT the attempt cap, so the drain's retry
 * pass never picks it up. Its caller already has the failure in hand — the
 * composer showing a test that didn't go out — and decides what happens next.
 * Letting the drain re-send it instead meant an admin who saw a failed test
 * and sent another got the first one too, five and thirty minutes later, with
 * no dedupe key; and a timeout can mean the provider accepted the first
 * request, so those were duplicates on a real phone. A send that wants the
 * retry ladder goes through enqueueSms, where the drain owns the attempt.
 */
async function recordSend(args: {
  to: string;
  toName?: string | null;
  userId?: string | null;
  party: ConsentParty;
  purpose: ConsentPurpose;
  body: string;
  segments: number;
  templateKey?: string;
  campaignId?: string | null;
  dedupeKey?: string;
  result: Awaited<ReturnType<ReturnType<typeof providerFor>["send"]>>;
}): Promise<string | null> {
  const admin = createAdminClient();
  const ok = args.result.ok;
  const { data, error } = await admin
    .from("sms_outbox")
    .insert({
      to_phone: args.to,
      to_name: args.toName ?? null,
      user_id: args.userId ?? null,
      party: args.party,
      purpose: args.purpose,
      body: args.body,
      segments: args.segments,
      template_key: args.templateKey ?? null,
      campaign_id: args.campaignId ?? null,
      status: ok ? "sent" : "failed",
      attempts: ok ? 1 : MAX_ATTEMPTS,
      last_error: ok ? null : args.result.reason,
      provider_id: ok ? args.result.providerId : null,
      dedupe_key: args.dedupeKey ?? null,
      sent_at: ok ? new Date().toISOString() : null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    // A dedupe collision means this exact send already happened — not an error
    // worth surfacing, and the reason the unique index exists.
    if (!isMissingSchemaError(error)) {
      console.error("[sms/send] could not record outbox row", error.message);
    }
    return null;
  }
  return data?.id ?? null;
}

export type EnqueueArgs = SendSmsArgs & {
  sendAfter?: Date;
  segments?: number;
  party?: ConsentParty;
};

/**
 * Park a message in the outbox for the drain to pick up.
 *
 * Used by campaigns (which always queue, so a 300-person blast doesn't have to
 * finish inside one request) and by sendSms when quiet hours defer a message.
 * Consent is NOT re-checked here — the drain checks it at send time, which is
 * both later and therefore more correct. The purpose policy IS checked: a row
 * the drain is guaranteed to refuse should never be written.
 */
export async function enqueueSms(
  args: EnqueueArgs,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const to = normalizeToE164(args.to);
  if (!to) return { ok: false, error: "Not a number we can read." };
  if (!isPurposeAllowed(args.purpose)) return { ok: false, error: PURPOSE_REFUSED };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("sms_outbox")
    .insert({
      to_phone: to,
      to_name: args.toName ?? null,
      user_id: args.userId ?? null,
      party: args.party ?? "unknown",
      purpose: args.purpose,
      body: args.body,
      segments: args.segments ?? countSegments(args.body),
      template_key: args.templateKey ?? null,
      campaign_id: args.campaignId ?? null,
      send_after: (args.sendAfter ?? new Date()).toISOString(),
      dedupe_key: args.dedupeKey ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 — the dedupe key already exists, so the logical send is already
    // queued or sent. Idempotency working as designed, not a failure.
    if ((error as any).code === "23505") {
      return { ok: false, error: "Already queued (duplicate dedupe key)." };
    }
    return { ok: false, error: error.message };
  }
  if (!data?.id) return { ok: false, error: "Insert returned no row." };
  return { ok: true, id: data.id };
}
