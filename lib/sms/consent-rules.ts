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
// Import-free except for ./policy.ts, which is itself import-free.
// ---------------------------------------------------------------------------

import { isPurposeAllowed, PURPOSE_REFUSED, type SmsPurpose } from "./policy.ts";

export type ConsentParty = "student" | "parent" | "unknown";

/** The columns of a `messaging_consent` row the rules need. */
export type ConsentRow = {
  party: ConsentParty | string | null;
  transactional: boolean | null;
  promotional: boolean | null;
  opted_out_at: string | null;
  opted_out_source: string | null;
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
// exactly what OPT_OUT_REPLY and /messages tell people, so the rule and the
// published promise agree. An opt-out the dashboard itself recorded IS liftable
// there — same person, same session, nobody being overruled.
// ---------------------------------------------------------------------------

/** Opt-out sources the web form may not lift. */
export const OPT_OUTS_THE_FORM_CANNOT_LIFT: ReadonlySet<string> = new Set([
  "sms_stop",
  "provider_21610",
  "admin",
]);

/** May a grant from `grantSource` clear an opt-out recorded from `optedOutSource`? */
export function mayLiftOptOut(optedOutSource: string | null, grantSource: string): boolean {
  if (grantSource === "sms_start") return true;
  // An admin opting their own phone in for a test send never undoes anybody's
  // opt-out — not even one the dashboard recorded. The number may not be theirs.
  if (grantSource === "admin_test") return false;
  return !OPT_OUTS_THE_FORM_CANNOT_LIFT.has(optedOutSource ?? "");
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
  if (suppressed && !mayLiftOptOut(existing?.opted_out_source ?? null, req.source)) {
    return {
      ok: false,
      error:
        existing?.opted_out_source === "admin"
          ? "We were asked to stop texting that number, so it can only be turned back on from the phone itself — text START to our number — or by asking us at batch0.org/support."
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

function normalizeParty(p: unknown): ConsentParty | null {
  return p === "student" || p === "parent" || p === "unknown" ? p : null;
}
