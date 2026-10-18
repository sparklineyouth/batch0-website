import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { isReachableByTollFree, normalizeToE164 } from "@/lib/phone";
import { resolveAudience, MAX_AUDIENCE } from "@/lib/email/audience";
import { sendableNumbers } from "@/lib/sms/consent";
import { canOptInAtAge, type SmsAudienceSegment } from "@/lib/sms/policy";

/**
 * Turn an audience segment into the numbers we may actually text.
 *
 * Builds on lib/email/audience.ts rather than re-querying: the segment
 * definitions, the cohort filter and the one-row-per-person collapse are hard-
 * won and must not drift between channels. This adds the two things SMS needs
 * that email does not — a number per member, and an honest account of everyone
 * we CAN'T reach.
 *
 * The unreachable count is the point of this module as much as the reachable
 * list is. A composer that says "sending to 34 people" when 31 of them have no
 * number on file is worse than useless, because it hides the thing the operator
 * needs to fix. So every member who drops out does so with a reason.
 *
 * Program texts only (lib/sms/policy.ts), so the number is always the
 * student's own: the one on their newest application, the same row
 * /dashboard/phone writes. It is normalized here with lib/phone.ts — the same
 * function the opt-in used when it recorded consent against it — rather than
 * read from a stored copy, so the two can't disagree about what the number is.
 */

export type SmsRecipient = {
  phone: string;
  name: string | null;
  userId: string;
  party: "student";
};

export type UnreachableReason =
  | "no_number"
  | "unreadable_number"
  | "outside_nanp"
  | "under_age"
  | "no_consent";

export type SmsAudience = {
  recipients: SmsRecipient[];
  /** One entry per person we cannot text, with why. Drives the composer banner. */
  unreachable: { userId: string; name: string | null; reason: UnreachableReason }[];
  /** Totals by reason, for the one-line summary. */
  counts: Record<UnreachableReason, number>;
};

export type SmsAudienceSpec = {
  segment: SmsAudienceSegment;
  cohortId?: string | null;
};

function emptyCounts(): Record<UnreachableReason, number> {
  return {
    no_number: 0,
    unreadable_number: 0,
    outside_nanp: 0,
    under_age: 0,
    no_consent: 0,
  };
}

/** Resolve `spec` to the student numbers that may get a program text. */
export async function resolveSmsAudience(spec: SmsAudienceSpec): Promise<SmsAudience> {
  // includeParents is deliberately absent. For email it is the operator's
  // choice; nothing in texting reaches a parent's number (see the header).
  const members = await resolveAudience({
    segment: spec.segment,
    cohortId: spec.cohortId || null,
  });
  const counts = emptyCounts();
  const unreachable: SmsAudience["unreachable"] = [];

  if (members.length === 0) return { recipients: [], unreachable, counts };

  // One query for every candidate number, keyed by user.
  const admin = createAdminClient();
  const userIds = members.map((m) => m.userId);
  const { data, error } = await admin
    .from("applications")
    .select("user_id, phone, age, created_at")
    .in("user_id", userIds)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.error("[sms/audience] number lookup failed", error.message);
    // Fail closed: no numbers rather than a partial audience that looks complete.
    return {
      recipients: [],
      unreachable: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        reason: "no_number" as const,
      })),
      counts: { ...counts, no_number: members.length },
    };
  }

  // Newest application per user wins — same rule /dashboard/phone writes under.
  const byUser = new Map<string, { phone: string | null; age: number | null }>();
  for (const row of (data ?? []) as { user_id: string; phone: string | null; age: number | null }[]) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, { phone: row.phone, age: row.age });
  }

  const candidates: SmsRecipient[] = [];
  for (const m of members) {
    const app = byUser.get(m.userId);
    const raw = app?.phone?.trim() || null;
    const phone = normalizeToE164(raw);
    const drop = (reason: UnreachableReason) => {
      counts[reason]++;
      unreachable.push({ userId: m.userId, name: m.name, reason });
    };

    if (!raw) {
      drop("no_number");
      continue;
    }
    if (!phone) {
      // A raw number that won't normalize is a different problem from no number
      // at all — it is a data-repair task with a known target, so it gets its
      // own reason.
      drop("unreadable_number");
      continue;
    }
    if (!isReachableByTollFree(phone)) {
      drop("outside_nanp");
      continue;
    }
    if (!canOptInAtAge(app?.age ?? null)) {
      // Counted on its own rather than folded into no_consent: nobody can fix
      // it by asking, and the operator should not go looking for a consent that
      // the opt-in page will never let this student give.
      drop("under_age");
      continue;
    }
    candidates.push({ phone, name: m.name, userId: m.userId, party: "student" });
  }

  // Consent, in one query for the whole set.
  const allowed = await sendableNumbers(
    candidates.map((c) => c.phone),
    "transactional",
  );

  const recipients: SmsRecipient[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!allowed.has(c.phone)) {
      counts.no_consent++;
      unreachable.push({ userId: c.userId, name: c.name, reason: "no_consent" });
      continue;
    }
    // Dedupe on the number, not the user. Siblings can share a phone, and
    // without this that phone gets the same campaign once per child.
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    recipients.push(c);
  }

  return { recipients: recipients.slice(0, MAX_AUDIENCE), unreachable, counts };
}

/** Human-readable label for the composer's unreachable banner. */
export const UNREACHABLE_LABELS: Record<UnreachableReason, string> = {
  no_number: "no number on file",
  unreadable_number: "number we couldn't read",
  outside_nanp: "outside the US/Canada",
  under_age: "under 13 — texts aren't offered",
  no_consent: "hasn't opted in to texts",
};

export type MissingConsentRow = {
  userId: string;
  email: string;
  name: string | null;
  status: string;
  hasNumber: boolean;
  /** False when the number on file can't be normalized or isn't NANP. */
  textableNumber: boolean;
  underAge: boolean;
  consent: boolean;
  optedOut: boolean;
};

/**
 * Everyone in the program and where they stand on texts — the collection
 * worklist behind /admin/sms/collect.
 *
 * The `statuses` default is a list, not a single value, and that is the point:
 * filtering `status = 'accepted'` alone silently excludes every student who has
 * PAID — paying is what moves an application on to `paid` and `enrolled` — so
 * the people most worth being able to text would be the only ones it could
 * never ask.
 */
export async function getMissingSmsConsent(
  statuses: string[] = ["accepted", "paid", "enrolled"],
): Promise<{ ok: true; rows: MissingConsentRow[] } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("applications")
    .select(
      "user_id, status, phone, age, created_at, profile:profiles!applications_user_id_fkey(email, full_name)",
    )
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return { ok: false, error: error.message };

  const byUser = new Map<string, any>();
  for (const row of (data ?? []) as any[]) {
    if (row.user_id && !byUser.has(row.user_id)) byUser.set(row.user_id, row);
  }

  const numbers = Array.from(byUser.values())
    .map((r) => normalizeToE164(r.phone))
    .filter((n): n is string => Boolean(n));

  // One consent read for every number in play.
  const consented = new Set<string>();
  const optedOut = new Set<string>();
  if (numbers.length > 0) {
    const { data: consent, error: consentError } = await admin
      .from("messaging_consent")
      .select("phone_e164, transactional, opted_out_at")
      .in("phone_e164", numbers);
    if (consentError) {
      return {
        ok: false,
        error: isMissingSchemaError(consentError)
          ? "Texting isn't set up yet: migration 0106 hasn't run."
          : consentError.message,
      };
    }
    for (const c of (consent ?? []) as {
      phone_e164: string;
      transactional: boolean;
      opted_out_at: string | null;
    }[]) {
      if (c.opted_out_at) optedOut.add(c.phone_e164);
      else if (c.transactional) consented.add(c.phone_e164);
    }
  }

  const rows = Array.from(byUser.values())
    .map((r) => {
      const profile = Array.isArray(r.profile) ? r.profile[0] : r.profile;
      const phone = normalizeToE164(r.phone);
      return {
        userId: r.user_id as string,
        email: (profile?.email ?? "") as string,
        name: (profile?.full_name ?? null) as string | null,
        status: r.status as string,
        hasNumber: Boolean(String(r.phone ?? "").trim()),
        textableNumber: Boolean(phone && isReachableByTollFree(phone)),
        underAge: !canOptInAtAge(r.age ?? null),
        consent: Boolean(phone && consented.has(phone)),
        optedOut: Boolean(phone && optedOut.has(phone)),
      };
    })
    .filter((r) => r.email);

  return { ok: true, rows };
}
