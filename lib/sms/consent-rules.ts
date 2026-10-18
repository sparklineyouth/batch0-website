// ---------------------------------------------------------------------------
// The consent decisions, without the database.
//
// lib/sms/consent.ts reads a `messaging_consent` row, asks this module what to
// do with it, and writes the answer. Splitting the deciding from the writing is
// what lets lib/sms-consent-rules.test.ts pin every rule below against plain
// objects: the server module reaches Supabase through the "@/…" alias, which
// `node --test` cannot resolve, and a rule that is only exercised against a
// live database is a rule nobody runs.
//
// Import-free except for ./policy.ts and ./keywords.ts, which are themselves
// import-free.
// ---------------------------------------------------------------------------

import { isOptOutRequest } from "./keywords.ts";
import { isPurposeAllowed, PURPOSE_REFUSED, type SmsPurpose } from "./policy.ts";

export type ConsentParty = "student" | "parent" | "unknown";

/** The columns of a `messaging_consent` row the rules need. */
export type ConsentRow = {
  party: ConsentParty | string | null;
  transactional: boolean | null;
  promotional: boolean | null;
  opted_out_at: string | null;
  opted_out_source: string | null;
  /** The account that turned texts off, when it was an account (0106). */
  opted_out_by?: string | null;
  first_opted_in_at?: string | null;
};

// ---------------------------------------------------------------------------
// Who may lift an opt-out
//
// An opt-out that arrived from the handset (STOP), from the network (a carrier
// 21610) or through a person who asked us by another route and had an admin
// record it — a reply to an email, a support request, a guardian asking us to
// stop texting their student — is not the web form's to undo. Anyone can type a
// number into a form, so if a form could clear those, the suppression list would
// be advisory: a sibling, or anyone at all, could enter a number that had opted
// out, tick a box on its behalf, and put it straight back into a campaign. And a
// guardian's request would last exactly until their student next saved the
// page.
//
// Lifting one of these takes a START text FROM the number itself. That is also
// exactly what OPT_OUT_REPLY and /texts tell people, so the rule and the
// published promise agree.
//
// The form can lift exactly one kind of opt-out: one the dashboard recorded,
// and only for the ACCOUNT that recorded it. Turning texts off and back on
// from your own dashboard overrules nobody. But a number is keyed on its own,
// not by account (0106), precisely because siblings share phones — and if any
// account could clear a dashboard opt-out, sibling B saving the shared number
// with the box ticked would undo sibling A's "Turn texts off" without A ever
// agreeing again. An opt-out with no recorded account can't be matched to
// anyone, so it waits for START too.
// ---------------------------------------------------------------------------

/** Opt-out sources the web form may never lift, whoever is asking. */
export const OPT_OUTS_THE_FORM_CANNOT_LIFT: ReadonlySet<string> = new Set([
  "sms_stop",
  "provider_21610",
  "admin",
]);

/**
 * May a grant from `grantSource`, made by `who.userId`, clear an opt-out
 * recorded from `optedOutSource` by `who.optedOutBy`?
 *
 * An allowlist: a source this function has never heard of stays suppressed
 * until START, rather than becoming liftable by default.
 */
export function mayLiftOptOut(
  optedOutSource: string | null,
  grantSource: string,
  who: { optedOutBy?: string | null; userId?: string | null } = {},
): boolean {
  if (grantSource === "sms_start") return true;
  // An admin opting their own phone in for a test send never undoes anybody's
  // opt-out — not even one the dashboard recorded. The number may not be theirs.
  if (grantSource !== "dashboard_phone") return false;
  if (optedOutSource !== "dashboard_phone") return false;
  return Boolean(who.optedOutBy && who.userId && who.optedOutBy === who.userId);
}

/**
 * Does a STOP from the handset need recording, even though the number is
 * already suppressed?
 *
 * Yes when the suppression is one a form could lift: a dashboard opt-out. The
 * person has now said it from the phone as well, and that has to lock the
 * number the way any STOP does — otherwise opted_out_source stays
 * `dashboard_phone`, the form can still clear it, and the STOP did nothing.
 * A STOP onto a STOP, a carrier block or an admin-recorded request changes
 * nothing: those already take a START to lift.
 */
export function stopShouldBeRecorded(row: ConsentRow | null): boolean {
  if (!row?.opted_out_at) return true;
  return !OPT_OUTS_THE_FORM_CANNOT_LIFT.has(row.opted_out_source ?? "");
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

export type GrantRequest = {
  party: ConsentParty;
  purposes: readonly string[];
  /**
   * 'dashboard_phone' — a student, for their own number, at /dashboard/phone
   * 'sms_start'       — the number itself, replying START
   * 'admin_test'      — someone with sms.send, for their OWN phone, so the
   *                     campaign composer's test send can reach it
   */
  source: string;
  /** The account making the grant; what a dashboard opt-out is matched against. */
  userId?: string | null;
};

export type GrantPlan =
  | {
      ok: true;
      /** The party the row ends up with. */
      party: ConsentParty;
      transactional: boolean;
      promotional: boolean;
      /** True when this grant clears an existing opt-out. */
      liftsOptOut: boolean;
    }
  | { ok: false; error: string };

/**
 * What a grant would do to `existing`, or why it is refused.
 *
 * Decided in full before anything is written, so a refusal never leaves a
 * ledger row behind for a grant we then didn't honour.
 */
export function planGrant(existing: ConsentRow | null, req: GrantRequest): GrantPlan {
  if (req.purposes.length === 0) return { ok: false, error: "No purposes given." };
  for (const p of req.purposes) {
    if (!isPurposeAllowed(p)) return { ok: false, error: PURPOSE_REFUSED };
  }
  if (req.party === "student" && req.purposes.includes("promotional")) {
    // Also enforced by a CHECK constraint in 0106. Caught here so the caller
    // gets a readable error instead of a Postgres violation.
    return {
      ok: false,
      error: "A student's number cannot carry promotional consent.",
    };
  }

  const existingParty = normalizeParty(existing?.party);

  // A test opt-in is only for a number nobody else has a claim on. A number a
  // student opted in (or out) is that student's, and an admin typing it into
  // the test field must not be able to add a permission they never gave.
  if (req.source === "admin_test" && existingParty && existingParty !== "unknown") {
    return {
      ok: false,
      error:
        "That number is on file as a student's own mobile, so it can't be opted in for a test. Test on your own phone.",
    };
  }

  // A number is one person's. Refusing to re-label rather than quietly
  // overwriting is the whole defence here: the party column is what decides
  // whether anything promotional could ever reach this handset, so a party
  // change has to be an explicit, human decision and not a side effect of
  // somebody filling in a form. `unknown` is not a claim, so promoting it to
  // either side is fine.
  if (
    existingParty &&
    existingParty !== "unknown" &&
    req.party !== "unknown" &&
    existingParty !== req.party
  ) {
    return {
      ok: false,
      error:
        existingParty === "student"
          ? "That number is already on file as a student's own mobile, so it can't be added as a parent or guardian number."
          : "That number is already on file as a parent or guardian number, so it can't also be registered as a student's own mobile. Please use your own number.",
    };
  }

  const party: ConsentParty = req.party !== "unknown" ? req.party : (existingParty ?? "unknown");

  // The merged result, not just the incoming purposes, has to satisfy the
  // student rule — a student grant onto a number that already carries
  // promotional consent would otherwise build a row the CHECK rejects.
  const transactional = req.purposes.includes("transactional") || Boolean(existing?.transactional);
  const promotional = req.purposes.includes("promotional") || Boolean(existing?.promotional);
  if (party === "student" && promotional) {
    return {
      ok: false,
      error:
        "That number already carries promotional consent, so it can't be registered as a student's own mobile. Please check the number.",
    };
  }

  const suppressed = Boolean(existing?.opted_out_at);
  if (
    suppressed &&
    !mayLiftOptOut(existing?.opted_out_source ?? null, req.source, {
      optedOutBy: existing?.opted_out_by ?? null,
      userId: req.userId ?? null,
    })
  ) {
    const source = existing?.opted_out_source;
    return {
      ok: false,
      error:
        source === "admin"
          ? "We were asked to stop texting that number, so it can only be turned back on from the phone itself — text START to our number — or by asking us at batch0.org/support."
          : source === "dashboard_phone"
            ? "Texts to that number were turned off from another batch0 account, so they can only be turned back on from the phone itself — text START to our number."
            : "That number replied STOP, so it can only be resubscribed from the phone itself — text START to our number.",
    };
  }

  return { ok: true, party, transactional, promotional, liftsOptOut: suppressed };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type SendVerdict =
  | { allowed: true; party: ConsentParty }
  | { allowed: false; reason: string };

/**
 * May `purpose` be sent to the number this row describes?
 *
 * Fail-closed throughout: no row, an opt-out, a purpose the policy doesn't
 * allow, or a purpose the person never agreed to are all a no. An opt-out is
 * checked before the purpose flags on purpose — `opted_out_at` outranks
 * everything, so no future purpose can route around it.
 */
export function sendVerdict(row: ConsentRow | null, purpose: SmsPurpose | string): SendVerdict {
  if (!isPurposeAllowed(purpose)) return { allowed: false, reason: PURPOSE_REFUSED };
  if (!row) return { allowed: false, reason: "No consent on file for this number." };
  if (row.opted_out_at) return { allowed: false, reason: "This number has opted out." };
  if (purpose === "promotional" && !row.promotional) {
    return { allowed: false, reason: "No promotional consent for this number." };
  }
  if (purpose === "transactional" && !row.transactional) {
    return { allowed: false, reason: "No transactional consent for this number." };
  }
  return { allowed: true, party: normalizeParty(row.party) ?? "unknown" };
}

/**
 * May a campaign text this number?
 *
 * The send gate plus one more rule: the number was opted in as a STUDENT's
 * own. A campaign's audience is students' application numbers, and the only
 * consent that speaks for a student's number is the student's own tick at
 * /dashboard/phone (or a START restoring it). The admin's "this is my own
 * phone" test opt-in writes party `unknown`, and is for test sends only —
 * so even if one ever landed on a number that is also on an application, it
 * could not put that student into a campaign they never agreed to.
 */
export function campaignMayText(row: ConsentRow | null): boolean {
  if (!sendVerdict(row, "transactional").allowed) return false;
  return normalizeParty(row?.party) === "student";
}

/**
 * The purposes START gives back: exactly the ones already on the row, never
 * more, and only those the policy still allows. Someone who had program texts
 * and replies START gets program texts back, not a wider subscription.
 */
export function purposesToRestore(row: ConsentRow | null): SmsPurpose[] {
  if (!row) return [];
  const out: SmsPurpose[] = [];
  if (row.transactional && isPurposeAllowed("transactional")) out.push("transactional");
  if (row.promotional && isPurposeAllowed("promotional")) out.push("promotional");
  return out;
}

// ---------------------------------------------------------------------------
// Revocations the webhook didn't record
//
// The webhook answers 500 when it can't write an opt-out, and Twilio retries
// that only because the console URL carries a retry override
// (lib/sms/webhook-url.ts). If every retry also fails — a long database
// outage — the inbound text is usually still in sms_events (it is logged
// first), and the drain re-reads recent inbound texts and records any opt-out
// that has nothing after it in the ledger. A revocation is a promise with a
// ten-business-day clock; it can't depend on one HTTP request succeeding.
// ---------------------------------------------------------------------------

export type InboundLogRow = { phone_e164: string | null; body: string | null; created_at: string };
export type LedgerRow = { phone_e164: string; action: string; source: string; created_at: string };

/**
 * The numbers whose most recent opt-out text has not been acted on.
 *
 * Per number, the latest inbound text that is an opt-out (isOptOutRequest, the
 * webhook's own rule) counts as handled when, at or after it:
 *   * the ledger has a revoke for the number — the webhook (or an earlier
 *     pass) recorded it; or
 *   * the ledger has a START grant — the person changed their mind, by the one
 *     route that can lift a STOP.
 * It also counts as handled when the number is already suppressed in a way
 * only START lifts. Anything else — not suppressed, or suppressed only by a
 * dashboard opt-out a form could undo — is a revocation still owed.
 *
 * A later dashboard tick does NOT count as superseding: had the webhook
 * recorded the STOP, that tick would have been refused (mayLiftOptOut).
 */
export function unrecordedOptOuts(
  inbound: readonly InboundLogRow[],
  consentByPhone: ReadonlyMap<string, ConsentRow>,
  ledger: readonly LedgerRow[],
): { phone: string; body: string; at: string }[] {
  const latest = new Map<string, { body: string; at: string }>();
  for (const e of inbound) {
    if (!e.phone_e164 || !e.body || !isOptOutRequest(e.body)) continue;
    const prior = latest.get(e.phone_e164);
    if (!prior || Date.parse(e.created_at) > Date.parse(prior.at)) {
      latest.set(e.phone_e164, { body: e.body, at: e.created_at });
    }
  }

  const owed: { phone: string; body: string; at: string }[] = [];
  for (const [phone, ev] of latest) {
    const at = Date.parse(ev.at);
    const answered = ledger.some(
      (l) =>
        l.phone_e164 === phone &&
        Date.parse(l.created_at) >= at &&
        (l.action === "revoke" || (l.action === "grant" && l.source === "sms_start")),
    );
    if (answered) continue;
    if (!stopShouldBeRecorded(consentByPhone.get(phone) ?? null)) continue;
    owed.push({ phone, body: ev.body, at: ev.at });
  }
  return owed;
}

function normalizeParty(p: unknown): ConsentParty | null {
  return p === "student" || p === "parent" || p === "unknown" ? p : null;
}
