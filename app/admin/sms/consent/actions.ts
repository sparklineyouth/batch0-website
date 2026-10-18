"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { maskE164, normalizeToE164 } from "@/lib/phone";
import { revokeConsent } from "@/lib/sms/consent";

/** Long enough for "Support B0-4F2A-9C7K: parent asked us to stop texting Ana". */
const NOTE_MAX = 500;

/**
 * Record an opt-out that reached us some other way than a text.
 *
 * Since April 11, 2025 a person may revoke consent "by any reasonable method",
 * and the privacy policy says so: a reply to one of our emails, a support
 * request, hello@batch0.org, a parent or guardian asking us to stop texting
 * their student. Each of those has to become the same suppression a STOP does,
 * inside 10 business days, or it is a note in an inbox the transport never
 * reads.
 *
 * Gated on `sms.view`, the key that opens this page, rather than a write key:
 * the only thing this can do is stop texts. The worst a mistaken click does is
 * silence a number until it replies START, and the person handling the request
 * that asked for it should not have to find someone who can send campaigns.
 *
 * Suppresses whether or not the number has ever opted in: someone asking us not
 * to text a number we hold no consent for is still asking, and the row is what
 * keeps a later opt-in from a different account — a sibling, say — from
 * re-subscribing it. Only a START from the phone lifts it
 * (lib/sms/consent-rules.ts).
 */
export async function recordOptOut(input: {
  phone: string;
  note: string;
}): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const { userId } = await assertPermission("sms.view");

  const phone = normalizeToE164(input.phone);
  if (!phone) {
    return { ok: false, error: "That isn't a number we can read. Include the area code." };
  }
  const note = input.note.trim();
  if (!note) {
    return {
      ok: false,
      error:
        "Say who asked and where — a support reference or the email — so the record shows why this number stopped.",
    };
  }
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` };
  }

  const res = await revokeConsent({
    phone,
    source: "admin",
    // The ledger's evidence column for a revoke. Prefixed so the consent page
    // reads as "who recorded it", not as a text the person sent.
    inboundBody: `Recorded by an admin: ${note}`,
    userId: null,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await logAudit({
    action: "sms.opt_out_recorded",
    targetType: "messaging_consent",
    targetId: maskE164(phone),
    payload: { phone: maskE164(phone), note, recordedBy: userId },
  });

  revalidatePath("/admin/sms/consent");
  revalidatePath("/admin/sms/outbox");
  return {
    ok: true,
    notice: `Done — ${maskE164(phone)} won't get any more texts, and anything queued to it was cancelled.`,
  };
}
