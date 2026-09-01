"use server";
import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { Templates, passRedeemUrl } from "@/lib/email/templates";
import { nextBatchDefaults } from "@/lib/founder-pass-batch";
import { passHolderUserIds } from "@/lib/founder-pass";
import {
  DEFAULT_TIER,
  formatCents,
  grantOf,
  grantPerkLines,
  parseDollarsToCents,
  passTier,
} from "@/lib/founder-pass-tiers";
import { STATUS_RANK } from "@/app/admin/email/blast/shared";
import { parseEmailList, INVITE_TEMPLATE_KEY } from "./shared";
import {
  hashPassCode,
  mintPassCode,
  normalizePassCode,
  requirePepper,
} from "@/lib/founder-pass-code";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/** One pass that was issued, as the admin needs to see it after the send. */
export type IssuedPass = {
  serial: number;
  code: string;
  email: string;
  name: string | null;
  /**
   * The same one-click redeem link the email carries.
   *
   * Here as well as in the inbox because delivery and redemption are separate
   * things that fail separately: an admin testing the flow, or handing a code
   * to someone standing in front of them, needs to be able to open the holder
   * experience without waiting on a mail server. It is not a second source of
   * truth — templates.founderPassInvite builds the same URL from the same
   * code — and it is no more sensitive than the code printed beside it.
   */
  redeemUrl: string;
};

export type IssueResult =
  | { ok: true; message: string; batch: string; passes: IssuedPass[] }
  | { ok: false; error: string };

/** One person a pass can be addressed to, as the admin picker shows them. */
export type PassRecipient = {
  /** Profile id, or null for someone who has no account yet. */
  id: string | null;
  email: string;
  name: string | null;
  role: string;
  /** Best (furthest-along) application status, or null if never applied. */
  appStatus: string | null;
  /** Whether they already hold a live pass — issuing a second one is wasted. */
  hasPass: boolean;
};

/**
 * The audiences the picker offers. Mirrors the email blast's segments (see
 * app/admin/email/blast/actions.ts) so "all students" means the same set of
 * people in both places — an admin who blasted a group and then wants to hand
 * that same group passes should not have to reason about two definitions.
 */
export type PassSegment =
  | "students"
  | "enrolled"
  | "accepted"
  | "waitlisted"
  | "applied"
  | "everyone";

const SEGMENTS: PassSegment[] = [
  "students",
  "enrolled",
  "accepted",
  "waitlisted",
  "applied",
  "everyone",
];

/**
 * Ceilings. These are not style — every pass permanently consumes a serial
 * that a printed card can then never use, and every pass is money off someone's
 * tuition. A mis-click on "everyone" must not be able to mint hundreds of live
 * passes or send hundreds of emails that cannot be recalled.
 */
const MAX_PER_RECIPIENT = 10;
const MAX_PASSES_PER_SEND = 200;

// Same shape the settings form uses. Deliberately loose — a stricter regex
// rejects valid addresses far more often than it catches real mistakes, and
// the real verdict comes from Resend either way.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * Resolve one audience segment to the people in it.
 *
 * Called by the form when the admin picks an audience, rather than the page
 * serializing the whole directory into props — the same shape, and the same
 * reason, as getRecipients() in the email blast.
 *
 * `hasPass` rides along so the picker can grey out people who already hold
 * one. Issuing a second pass to an existing holder is not just waste: redeem
 * refuses it ("already_have_pass"), so the code would be dead on arrival and
 * the serial spent for nothing.
 */
export async function getPassRecipients(
  segment: PassSegment,
): Promise<
  { ok: true; recipients: PassRecipient[] } | { ok: false; error: string }
> {
  await assertPermission("passes.manage");
  if (!SEGMENTS.includes(segment)) return { ok: false, error: "Unknown audience." };

  const admin = createAdminClient();
  let q = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, applications!applications_user_id_fkey(status), enrollments!enrollments_user_id_fkey(id)",
    )
    .order("created_at", { ascending: false })
    .limit(5000);
  if (segment === "students") q = q.eq("role", "student");

  const { data: profiles, error } = await q;
  if (error) return { ok: false, error: error.message };

  const rows = (profiles ?? []).filter((p: any) => p.email);
  const holders = await passHolderUserIds(
    admin,
    rows.map((p: any) => p.id),
  );

  const recipients: PassRecipient[] = rows
    .map((p: any) => {
      const statuses: string[] = (p.applications ?? []).map((a: any) => a.status);
      const appStatus =
        statuses.length > 0
          ? statuses.reduce((best, cur) =>
              (STATUS_RANK[cur] ?? -1) > (STATUS_RANK[best] ?? -1) ? cur : best,
            )
          : null;
      return {
        id: p.id as string,
        email: p.email as string,
        name: (p.full_name as string) || null,
        role: p.role as string,
        appStatus,
        enrolled: (p.enrollments ?? []).length > 0,
        hasPass: holders.has(p.id),
      };
    })
    .filter((r) => {
      switch (segment) {
        case "enrolled":
          return r.enrolled;
        case "accepted":
          return r.appStatus === "accepted";
        case "waitlisted":
          return r.appStatus === "waitlisted";
        case "applied":
          return r.appStatus === "submitted";
        default:
          return true;
      }
    })
    .map(({ enrolled: _enrolled, ...rest }) => rest);

  return { ok: true, recipients };
}

/**
 * Which of these addresses belong to an account that already holds a live pass.
 *
 * The picker greys those people out, but the check has to exist server-side as
 * well, and for both addressing modes: the typed-address path never saw that
 * list at all, and a client left open for ten minutes would happily post an id
 * the picker disabled after the person redeemed something.
 *
 * Matched on the lowercased address, which is how profiles.email is written
 * everywhere in this app. A row stored with different casing would slip
 * through — that is a miss, not a wrong answer: the send behaves exactly as it
 * did before this check existed.
 */
async function holdersAmong(
  admin: ReturnType<typeof createAdminClient>,
  emails: string[],
): Promise<string[]> {
  const wanted = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  if (wanted.length === 0) return [];
  const { data } = await admin
    .from("profiles")
    .select("id, email")
    .in("email", wanted);
  const rows = (data ?? []) as Array<{ id: string; email: string | null }>;
  if (rows.length === 0) return [];
  const held = await passHolderUserIds(
    admin,
    rows.map((r) => r.id),
  );
  return rows
    .filter((r) => held.has(r.id))
    .map((r) => (r.email ?? "").toLowerCase())
    .filter(Boolean);
}

/** Where a send's addresses come from. */
export type PassRecipientInput =
  | { mode: "emails"; emails: string }
  /**
   * Profile ids, never addresses. The server re-resolves each id to the email
   * on that profile, so a tampered request can't redirect a pass — and its
   * discount — to an arbitrary inbox. Same stance as sendBlast.
   */
  | { mode: "users"; userIds: string[] };

/**
 * Issue VIRTUAL founder passes and email the codes out.
 *
 * This is the email twin of the printed-card mint (app/api/admin/passes/mint):
 * same serial sequence, same alphabet, same peppered hash, same redemption at
 * /pass, same revoke. Only the delivery differs — no Onshape, no STL, no
 * printer.
 *
 * ORDERING — insert, then send, and revoke on a failed send.
 *
 * The printed path mints, exports every STL, and only then inserts, because a
 * failure after the insert would leave live rows whose codes exist nowhere.
 * That trick is unavailable here: an email cannot be prepared and held the way
 * a buffer can, and it certainly cannot be un-sent. So the two orders trade
 * one bad outcome for another:
 *
 *   send first  -> insert fails -> a real-looking code sits in someone's inbox
 *                  and will never redeem. Unfixable from their side, and it
 *                  reads as "batch0 sent me a broken pass".
 *   insert first -> send fails  -> a live row nobody has the code to. Fixable
 *                  in the same breath: revoke it, say so, try again.
 *
 * The second is strictly recoverable, so that is the order, and a failed send
 * revokes its row immediately rather than leaving a serial live-but-orphaned.
 *
 * The plaintext codes come back in the result for the same reason manifest.csv
 * exists: the database stores only hashes, so the admin's screen is the only
 * other copy. There is no resend — that is a consequence of not storing codes
 * (migration 0039), not an oversight.
 */
export async function issueVirtualPassesAction(input: {
  recipients: PassRecipientInput;
  /** Passes each recipient gets. Defaults to one. */
  perRecipient?: number;
  tier?: string;
  /**
   * The admin's discount box, as typed — dollars, parsed here. Blank means
   * "use the tier", which is not the same as "$0"; see normalizeDiscountCents.
   */
  discountDollars?: string;
  note?: string;
  /** Only meaningful for a single addressed recipient. */
  recipientName?: string;
}): Promise<IssueResult> {
  await assertPermission("passes.manage");

  const admin = createAdminClient();

  // ---- Who is getting one.
  let people: Array<{ email: string; name: string | null }>;
  if (input.recipients.mode === "users") {
    const ids = Array.from(new Set(input.recipients.userIds ?? [])).filter(Boolean);
    if (ids.length === 0) return { ok: false, error: "Pick at least one person." };
    const { data, error } = await admin
      .from("profiles")
      .select("id, email, full_name")
      .in("id", ids);
    if (error) return { ok: false, error: error.message };
    people = (data ?? [])
      .filter((p: any) => p.email)
      .map((p: any) => ({ email: String(p.email).toLowerCase(), name: p.full_name || null }));
    if (people.length === 0) {
      return { ok: false, error: "None of those people have an email address on file." };
    }
  } else {
    const emails = parseEmailList(input.recipients.emails ?? "");
    if (emails.length === 0) return { ok: false, error: "Enter at least one email address." };
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) {
      return {
        ok: false,
        error: `Not an email address: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ""}.`,
      };
    }
    const singleName = (input.recipientName ?? "").trim().slice(0, 120) || null;
    people = emails.map((email) => ({
      // A typed name belongs to ONE person, so it only rides along when
      // exactly one address was given. Greeting three different people as
      // "Ada" would be worse than greeting none of them by name.
      name: emails.length === 1 ? singleName : null,
      email,
    }));
  }

  // ---- Nobody who already holds one.
  //
  // redeemPass refuses a second pass per account ("already_have_pass"), so a
  // code sent to an existing holder is dead on arrival and its serial is spent
  // for nothing. Refusing the whole send rather than quietly dropping those
  // addresses: sending four passes when the box listed five, and never
  // mentioning the fifth, is how someone ends up believing a pass is sitting
  // in an inbox that never received one.
  const alreadyHold = await holdersAmong(
    admin,
    people.map((p) => p.email),
  );
  if (alreadyHold.length) {
    return {
      ok: false,
      error:
        `${alreadyHold.slice(0, 3).join(", ")}${
          alreadyHold.length > 3 ? ` (+${alreadyHold.length - 3} more)` : ""
        } already ${alreadyHold.length === 1 ? "holds" : "hold"} a live founder pass. ` +
        `One account can only hold one, so a second code could never be redeemed — ` +
        `take ${alreadyHold.length === 1 ? "them" : "those"} out and send the rest, ` +
        `or revoke the pass they have first.`,
    };
  }

  // ---- How many each.
  const perRecipient = Math.trunc(input.perRecipient ?? 1);
  if (!Number.isFinite(perRecipient) || perRecipient < 1 || perRecipient > MAX_PER_RECIPIENT) {
    return { ok: false, error: `Between 1 and ${MAX_PER_RECIPIENT} passes per person.` };
  }
  const total = people.length * perRecipient;
  if (total > MAX_PASSES_PER_SEND) {
    return {
      ok: false,
      error:
        `That's ${total} passes in one go, over the ${MAX_PASSES_PER_SEND} cap. ` +
        `Every pass burns a serial permanently and every email is unrecallable, ` +
        `so send it in smaller groups.`,
    };
  }

  const note = (input.note ?? "").trim().slice(0, 500) || null;

  // ---- What they carry. Resolved, not trusted: passTier() falls back to
  // standard for anything it doesn't recognise, so a stale client can only
  // under-grant, and can never write a key the 0055 check constraint rejects.
  const tier = passTier(input.tier);
  const discountCents = parseDollarsToCents(input.discountDollars ?? "");
  // "virtual" is not a guess — this action only ever issues virtual passes
  // (the insert below hard-codes kind: "virtual"). Passing it here is what puts
  // the auto-admit line in the invite email, so the promise the recipient reads
  // is the one lib/admissions.ts will keep.
  const grant = grantOf(tier, discountCents, "virtual");

  let pepper: string;
  try {
    pepper = requirePepper();
  } catch {
    // Mirrors the mint route: refuse rather than write hashes the redeem path
    // could never match.
    return {
      ok: false,
      error: "FOUNDER_PASS_PEPPER isn't set in this environment, so passes can't be issued here.",
    };
  }

  const { start, batch } = await nextBatchDefaults(admin, "virtual");

  const passes: IssuedPass[] = [];
  let offset = 0;
  for (const person of people) {
    for (let i = 0; i < perRecipient; i++) {
      const code = normalizePassCode(mintPassCode());
      passes.push({
        serial: start + offset++,
        code,
        email: person.email,
        name: person.name,
        // Built from the same helper the email's button uses, so the link the
        // admin can click here and the link the recipient clicks are the same
        // URL by construction rather than by two people remembering to.
        redeemUrl: passRedeemUrl(code),
      });
    }
  }

  const issuedAt = new Date().toISOString();
  const { error: insertError } = await admin.from("founder_passes").insert(
    passes.map((p) => ({
      serial: p.serial,
      code_hash: hashPassCode(p.code, pepper),
      batch,
      kind: "virtual",
      issued_to_email: p.email,
      issued_at: issuedAt,
      note,
      // Tier and discount are stamped in the SAME insert that creates the
      // code, so a pass can never exist without the perks it was promised.
      // There is no second write to forget and no window where a live code
      // carries the wrong terms.
      tier: tier.key,
      discount_cents: discountCents,
      recipient_name: p.name,
    })),
  );
  if (insertError) {
    // Nothing was sent. Two likely causes: a serial collision with a racing
    // mint (retrying recomputes a fresh start), or a migration not having been
    // applied yet — this repo's migrations are run by hand in the Supabase SQL
    // editor, so code can ship ahead of them. Name the second case explicitly;
    // PostgREST's raw "column does not exist" reads like a bug rather than a
    // to-do.
    const missingColumn = /column .* does not exist|schema cache/i.test(
      insertError.message,
    );
    return {
      ok: false,
      error: missingColumn
        ? `Couldn't issue the passes: ${insertError.message}. Virtual passes need migrations ` +
          `0054_virtual_founder_passes.sql, 0055_founder_pass_tiers.sql and ` +
          `0056_founder_pass_custom_discount.sql — run them in the Supabase SQL editor ` +
          `and try again.`
        : `Couldn't issue the passes: ${insertError.message}`,
    };
  }

  // --- Committed. Everything below is delivery, and delivery can fail.
  const perkLines = grantPerkLines(grant);
  const isStandard = tier.key === DEFAULT_TIER.key && discountCents === null;
  const sent: number[] = [];
  const failed: Array<{ serial: number; reason: string }> = [];
  for (const p of passes) {
    const t = Templates.founderPassInvite({
      code: p.code,
      serial: p.serial,
      tierLabel: tier.label,
      // From the grant itself, so the promises in this email are the same
      // strings the admin previewed and the holder will read on /pass.
      perkLines,
      isStandard,
      recipientName: p.name,
      note,
    });
    const r = await sendEmail({
      to: p.email,
      subject: t.subject,
      html: t.html,
      text: t.text,
      // Tags the message for /admin/email's metrics the same way every other
      // send in the app does. Without it a pass invite is the one transactional
      // email the delivery dashboard can't see — and a bounced invite is a live
      // serial nobody can redeem, which is exactly the failure worth spotting.
      templateKey: INVITE_TEMPLATE_KEY,
    });
    if (r.ok) sent.push(p.serial);
    else failed.push({ serial: p.serial, reason: r.reason ?? "unknown" });
  }

  // A pass whose email never left is a serial nobody can ever redeem. Kill it
  // now rather than leaving it live in the ledger looking issued.
  if (failed.length) {
    await admin
      .from("founder_passes")
      .update({ revoked_at: new Date().toISOString() })
      .in("serial", failed.map((f) => f.serial));
  }

  await logAudit({
    action: "founder_pass.issued_virtual",
    targetType: "founder_pass_batch",
    targetId: batch,
    payload: {
      batch,
      tier: tier.key,
      discount_cents: discountCents,
      recipients: people.length,
      per_recipient: perRecipient,
      requested: total,
      sent: sent.length,
      // Serials and addresses only — never the codes. The audit log is a
      // different blast radius from founder_passes, and putting plaintext
      // bearer tokens in it would undo the whole point of storing hashes next
      // door.
      sent_serials: sent,
      failed: failed.map((f) => ({ serial: f.serial, reason: f.reason })),
      revoked_on_failure: failed.map((f) => f.serial),
    },
  });

  revalidatePath("/admin/passes");

  if (sent.length === 0) {
    const disabled = failed.every((f) => f.reason === "disabled");
    return {
      ok: false,
      error: disabled
        ? "No email transport is configured, so nothing was sent. Set RESEND_API_KEY, or connect a mailbox at /admin/email/settings. The passes were revoked — no serials are stranded."
        : `Nothing was sent (${failed[0]?.reason ?? "unknown error"}). Those passes were revoked, so it's safe to try again.`,
    };
  }

  const delivered = passes.filter((p) => sent.includes(p.serial));
  const whoTo =
    people.length === 1
      ? people[0].email
      : `${people.length} people`;
  return {
    ok: true,
    batch,
    passes: delivered,
    message:
      `Sent ${delivered.length} ${grantDescription(grant)} pass${delivered.length === 1 ? "" : "es"} to ${whoTo} ` +
      `(batch "${batch}").` +
      (failed.length
        ? ` ${failed.length} couldn't be sent and ${failed.length === 1 ? "was" : "were"} revoked.`
        : "") +
      ` The code${delivered.length === 1 ? "" : "s"} below ${delivered.length === 1 ? "is" : "are"} the only copy outside those inboxes — the database keeps a hash, so there is no resend.`,
  };
}

/**
 * "founding" / "standard, $45 off" — for the confirmation line.
 *
 * Through formatCents rather than a local toFixed(0): rounding to whole
 * dollars here would report a $45.50 override back as "$45 off", which is the
 * admin's only confirmation of a number they typed and cannot change
 * afterwards.
 */
function grantDescription(grant: {
  tier: { label: string };
  discountCents: number | null;
}): string {
  const base = grant.tier.label.toLowerCase();
  if (grant.discountCents === null) return base;
  return `${base}, ${formatCents(grant.discountCents)} off`;
}

/**
 * Revoke a single pass. The card keeps existing physically; the code stops
 * working.
 *
 * Revoke, never delete — the row is the only record that serial was ever
 * issued, and deleting it would free the serial for reuse while a card bearing
 * that number is still in someone's pocket.
 */
export async function revokePassAction(serial: number): Promise<ActionResult> {
  await assertPermission("passes.manage");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("founder_passes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("serial", serial)
    .is("revoked_at", null)
    .select("serial, redeemed_by")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: `Pass #${serial} not found, or already revoked.` };

  const row = data as { serial: number; redeemed_by: string | null };
  await logAudit({
    action: "founder_pass.revoked",
    targetType: "founder_pass",
    targetId: String(serial),
    payload: { serial, was_redeemed_by: row.redeemed_by },
  });

  revalidatePath("/admin/passes");
  revalidatePath("/dashboard");
  return {
    ok: true,
    message: row.redeemed_by
      ? `Pass #${serial} revoked. Its holder loses the perks immediately.`
      : `Pass #${serial} revoked.`,
  };
}

/**
 * Revoke an entire batch — the answer to "that batch's code list leaked".
 *
 * This is why batch names exist as a column at all: one print run can be killed
 * without touching cards from any other run.
 */
export async function revokeBatchAction(batch: string): Promise<ActionResult> {
  await assertPermission("passes.manage");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("founder_passes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("batch", batch)
    .is("revoked_at", null)
    .select("serial, redeemed_by");

  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as Array<{ serial: number; redeemed_by: string | null }>;
  if (rows.length === 0) return { ok: false, error: `No live passes in batch "${batch}".` };

  const heldCount = rows.filter((r) => r.redeemed_by).length;

  await logAudit({
    action: "founder_pass.batch_revoked",
    targetType: "founder_pass_batch",
    targetId: batch,
    payload: { batch, revoked: rows.length, was_held: heldCount },
  });

  revalidatePath("/admin/passes");
  revalidatePath("/dashboard");
  return {
    ok: true,
    message:
      `Revoked ${rows.length} pass(es) in "${batch}".` +
      (heldCount > 0
        ? ` ${heldCount} were already redeemed — those people just lost their perks, so tell them.`
        : ""),
  };
}
