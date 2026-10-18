import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { isE164, isReachableByTollFree } from "@/lib/phone";
import { isPurposeAllowed, type SmsPurpose } from "@/lib/sms/policy";
import {
  planGrant,
  purposesToRestore,
  sendVerdict,
  type ConsentParty,
  type ConsentRow,
  type SendVerdict,
} from "@/lib/sms/consent-rules";

/**
 * Consent: who may we text, for what, and how do we prove it.
 *
 * This is the only part of the SMS feature with no email equivalent, and the
 * only part where being wrong is expensive rather than embarrassing. Three rules
 * hold the whole thing up:
 *
 * 1. THE NUMBER IS THE SUBJECT. Not the user. A carrier suppresses a number, an
 *    inbound STOP carries a number and no user id, and a recycled number reaches
 *    a stranger. `messaging_consent` is keyed on the number for that reason.
 *
 * 2. PROGRAM TEXTS ONLY. The privacy policy promises no marketing texts, so the
 *    only purpose this module will record or allow is `transactional`
 *    (lib/sms/policy.ts). A student's number could never carry promotional
 *    consent anyway — 0106's messaging_consent_no_promo_to_students check —
 *    because whether a minor can consent to marketing texts is a question we
 *    decline to be the test case for.
 *
 * 3. AN OPT-OUT OUTRANKS EVERYTHING. `opted_out_at` suppresses a number for
 *    every purpose regardless of the purpose flags, so the gate is a single
 *    `is null` test that no future purpose can accidentally route around.
 *
 * Fail-closed throughout. Every path that cannot answer "yes, they agreed"
 * answers "no" — including a database error, a missing table, and an
 * unrecognised number shape. The decisions themselves live in
 * lib/sms/consent-rules.ts so they can be tested without a database.
 */

export type { ConsentParty } from "@/lib/sms/consent-rules";
export type ConsentPurpose = SmsPurpose;

// ---------------------------------------------------------------------------
// The copy people actually agree to, and the keyword replies
//
// Defined in lib/sms/copy.ts, which has no imports so lib/sms-policy.test.ts
// can hold every sentence to the privacy policy's promises. Re-exported here
// so callers import consent things from one place.
// ---------------------------------------------------------------------------

export {
  CONSENT_COPY,
  HELP_REPLY,
  OPT_IN_REPLY,
  OPT_OUT_REPLY,
  UNMONITORED_REPLY,
} from "@/lib/sms/copy";

// ---------------------------------------------------------------------------
// Inbound keywords
//
// Re-exported from lib/sms/keywords.ts rather than defined here. That module has
// no imports, which is what lets `node --test` load it directly. Callers keep
// importing from here, so the split is invisible to them.
// ---------------------------------------------------------------------------

export {
  classifyInbound,
  expressesRevocation,
  type InboundIntent,
} from "@/lib/sms/keywords";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type { SendVerdict } from "@/lib/sms/consent-rules";

/**
 * May we send `purpose` to `phone` right now?
 *
 * Called from inside the transport (lib/sms/send.ts) and again by the drain,
 * rather than only at enqueue time, because consent can be revoked in the
 * minutes between a campaign being queued and a row being drained — and the
 * whole value of a suppression list is that it applies to mail already in
 * flight.
 */
export async function canSend(phone: string, purpose: ConsentPurpose): Promise<SendVerdict> {
  if (!isE164(phone)) {
    return { allowed: false, reason: "Not a normalized (E.164) number." };
  }
  if (!isReachableByTollFree(phone)) {
    // Accepted by the API and then dropped by the carrier, which bills and
    // reports as sent. Refusing here is the only way it shows up as a data
    // problem instead of a mystery.
    return {
      allowed: false,
      reason: "Outside the North American Numbering Plan — not deliverable from a toll-free number.",
    };
  }
  if (!isPurposeAllowed(purpose)) return sendVerdict(null, purpose);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messaging_consent")
    .select("party, transactional, promotional, opted_out_at, opted_out_source")
    .eq("phone_e164", phone)
    .maybeSingle();

  if (error) {
    if (isMissingSchemaError(error)) {
      return { allowed: false, reason: "Texting isn't set up yet — run migration 0106." };
    }
    // Fail closed. An unreadable consent record is not permission.
    return { allowed: false, reason: `Could not read consent: ${error.message}` };
  }
  return sendVerdict((data as ConsentRow | null) ?? null, purpose);
}

/** Bulk version, for showing a composer an accurate reachable count. */
export async function sendableNumbers(
  phones: string[],
  purpose: ConsentPurpose,
): Promise<Set<string>> {
  if (!isPurposeAllowed(purpose)) return new Set();
  const candidates = phones.filter((p) => isE164(p) && isReachableByTollFree(p));
  if (candidates.length === 0) return new Set();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messaging_consent")
    .select("phone_e164, party, transactional, promotional, opted_out_at, opted_out_source")
    .in("phone_e164", candidates)
    .is("opted_out_at", null);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("[sms/consent] sendableNumbers failed", error.message);
    }
    return new Set();
  }
  return new Set(
    ((data ?? []) as (ConsentRow & { phone_e164: string })[])
      .filter((r) => sendVerdict(r, purpose).allowed)
      .map((r) => r.phone_e164),
  );
}

// ---------------------------------------------------------------------------
// Writing consent
// ---------------------------------------------------------------------------

export type GrantArgs = {
  phone: string;
  userId?: string | null;
  party: ConsentParty;
  purposes: ConsentPurpose[];
  /** The EXACT sentence the person was shown. Stored verbatim as evidence. */
  consentText: string;
  /** 'dashboard_phone' | 'sms_start' | 'admin_test' — see GrantRequest. */
  source: string;
  sourceUrl?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type ConsentWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Record an opt-in.
 *
 * Writes the ledger row FIRST, then the current-state row. That order is
 * deliberate: if the second write fails we are left with evidence of a consent
 * we are not acting on, which is harmless. The reverse order would leave us
 * texting a number with no record of why we were allowed to — which is the one
 * state that cannot be explained to a regulator.
 */
export async function grantConsent(args: GrantArgs): Promise<ConsentWriteResult> {
  if (!isE164(args.phone)) return { ok: false, error: "Number is not in E.164 form." };

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Read BEFORE writing anything, and read the whole row that matters — the
  // party, the opt-out and its source are what the rules decide on.
  const { data: existing, error: readError } = await admin
    .from("messaging_consent")
    .select("party, transactional, promotional, opted_out_at, opted_out_source, first_opted_in_at")
    .eq("phone_e164", args.phone)
    .maybeSingle();
  if (readError) {
    return {
      ok: false,
      error: isMissingSchemaError(readError)
        ? "Texting isn't set up yet."
        : readError.message,
    };
  }

  const row = (existing as ConsentRow | null) ?? null;
  const plan = planGrant(row, {
    party: args.party,
    purposes: args.purposes,
    source: args.source,
  });
  if (!plan.ok) return plan;

  const { error: logError } = await admin.from("messaging_consent_log").insert({
    phone_e164: args.phone,
    user_id: args.userId ?? null,
    party: plan.party,
    action: "grant",
    purposes: args.purposes,
    consent_text: args.consentText,
    source: args.source,
    source_url: args.sourceUrl ?? null,
    ip: args.ip ?? null,
    user_agent: args.userAgent ?? null,
  });
  if (logError) return { ok: false, error: logError.message };

  const { error } = await admin.from("messaging_consent").upsert(
    {
      phone_e164: args.phone,
      // Only claim the account when there isn't one already. The first account a
      // number arrived through is the more useful provenance, and overwriting it
      // would let a later grant quietly reassign somebody else's number.
      ...(row ? {} : { user_id: args.userId ?? null }),
      party: plan.party,
      transactional: plan.transactional,
      promotional: plan.promotional,
      opted_out_at: null,
      opted_out_source: null,
      first_opted_in_at: row?.first_opted_in_at ?? now,
      last_opted_in_at: now,
      updated_at: now,
    },
    { onConflict: "phone_e164" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type RevokeArgs = {
  phone: string;
  /** 'sms_stop' | 'provider_21610' | 'dashboard_phone' | 'admin' */
  source: string;
  /** The inbound text, or for an admin-recorded opt-out what they were told. */
  inboundBody?: string | null;
  userId?: string | null;
};

/**
 * Record an opt-out, and stop anything already queued to the number.
 *
 * Upserts rather than updates, so a STOP from a number we have never written
 * still lands as a suppression row. That case is real — someone forwards a
 * message, or a number changed hands — and "we have no record of them, so we
 * ignored the STOP" is not a defence.
 *
 * The pending outbox rows are cancelled after the suppression lands, and a
 * failure to cancel them does not fail the opt-out: the drain re-checks consent
 * per row and would skip them anyway. Cancelling keeps the outbox honest — a
 * pending count that will never send is a lie in the UI.
 */
export async function revokeConsent(args: RevokeArgs): Promise<ConsentWriteResult> {
  if (!isE164(args.phone)) return { ok: false, error: "Number is not in E.164 form." };

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error: logError } = await admin.from("messaging_consent_log").insert({
    phone_e164: args.phone,
    user_id: args.userId ?? null,
    party: "unknown",
    action: "revoke",
    purposes: ["transactional", "promotional"],
    consent_text: null,
    source: args.source,
    inbound_body: args.inboundBody ?? null,
  });
  if (logError) return { ok: false, error: logError.message };

  const { data: existing } = await admin
    .from("messaging_consent")
    .select("party, user_id")
    .eq("phone_e164", args.phone)
    .maybeSingle();

  const { error } = await admin.from("messaging_consent").upsert(
    {
      phone_e164: args.phone,
      // Preserve what we knew; a STOP tells us nothing new about who they are.
      party: existing?.party ?? "unknown",
      user_id: existing?.user_id ?? args.userId ?? null,
      // The flags stay as they were on purpose. `opted_out_at` is what the gate
      // reads, and keeping the flags intact means a later START restores exactly
      // the purposes they had agreed to rather than silently widening them.
      opted_out_at: now,
      opted_out_source: args.source,
      updated_at: now,
    },
    { onConflict: "phone_e164" },
  );
  if (error) return { ok: false, error: error.message };

  const { error: cancelError } = await admin
    .from("sms_outbox")
    .update({
      status: "canceled",
      last_error:
        args.source === "sms_stop"
          ? "Recipient replied STOP"
          : `Number opted out (${args.source})`,
      updated_at: now,
    })
    .eq("to_phone", args.phone)
    .eq("status", "pending");
  if (cancelError) {
    console.error("[sms/consent] opted out, but pending rows weren't cancelled", cancelError.message);
  }
  return { ok: true };
}

/**
 * Re-enable a number after an opt-out, in response to START.
 *
 * Restores only the purposes already on the row — never widens. Someone who had
 * program texts and texts START gets program texts back, not a marketing
 * subscription.
 */
export async function restoreConsent(args: {
  phone: string;
  inboundBody?: string | null;
}): Promise<ConsentWriteResult & { restored?: ConsentPurpose[] }> {
  if (!isE164(args.phone)) return { ok: false, error: "Number is not in E.164 form." };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("messaging_consent")
    .select("party, user_id, transactional, promotional, opted_out_at, opted_out_source")
    .eq("phone_e164", args.phone)
    .maybeSingle();

  if (!existing) {
    // START from a number that never opted in is not consent. Answering it with
    // a subscription would be the classic "I texted one word and now I get
    // texts" complaint.
    return { ok: false, error: "No prior consent to restore for this number." };
  }

  const restored = purposesToRestore(existing as ConsentRow);
  if (restored.length === 0) {
    return { ok: false, error: "No purposes were ever granted for this number." };
  }

  return {
    ...(await grantConsent({
      phone: args.phone,
      userId: (existing.user_id as string | null) ?? null,
      party: ((existing.party as ConsentParty | null) ?? "unknown"),
      purposes: restored,
      consentText: `Resubscribed by replying ${JSON.stringify((args.inboundBody ?? "START").trim())}. Restored: ${restored.join(", ")}.`,
      source: "sms_start",
    })),
    restored,
  };
}
