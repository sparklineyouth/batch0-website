"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { isValidPhone, maskE164, normalizeToE164 } from "@/lib/phone";
import { canOptInAtAge } from "@/lib/sms/policy";
import { CONSENT_COPY, grantConsent, revokeConsent } from "@/lib/sms/consent";
import { env } from "@/lib/env";

export type SavePhoneResult = {
  ok: boolean;
  error?: string;
  /** What we recorded, in plain language, for the form's inline notice. */
  notice?: string;
};

/**
 * Where the consent ledger's evidence columns come from.
 *
 * `ip`, `user_agent` and `source_url` are not telemetry — they are the answer
 * to "prove this person ticked this box", which is the question a carrier's
 * vetting team asks before it approves a sending number and the question a TCPA
 * claim turns on. x-forwarded-for is client-settable and only its first hop is
 * ours, so we keep that hop and drop the rest of the chain: a fabricated-
 * looking value is worse evidence than an honest partial one.
 */
async function consentEvidence(): Promise<{
  ip: string | null;
  userAgent: string | null;
  sourceUrl: string;
}> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return {
    ip: fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip"),
    userAgent: h.get("user-agent"),
    sourceUrl: `${env.siteUrl}/dashboard/phone`,
  };
}

/** The caller's most-recent application — the same row /dashboard/accepted reads. */
async function ownApplication(userId: string) {
  const admin = createAdminClient();
  return admin
    .from("applications")
    .select("id, phone, age")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

/**
 * Save the signed-in student's phone number onto their most-recent
 * application, and record text permission if they just gave it.
 *
 * Written through the SERVICE-ROLE client on purpose: the "applications self
 * update draft" RLS policy only lets a student update their own row while it's
 * still a draft, and the people this page exists for were accepted long ago.
 * So the user client can't write here. The admin client can — and the write is
 * hard-scoped to `user_id = user.id`, the id from the verified session, so it
 * can only ever touch the caller's own application no matter what's posted.
 *
 * UNCHECKED IS NOT REVOKE. A missing `consentStudent` field means "don't
 * grant", nothing more. Treating it as a revocation would let any stray
 * resubmit — a student fixing a typo in their number, a browser replaying a
 * form, a double-click — silently suppress a number the person never asked to
 * suppress, and the ledger would record a withdrawal they didn't make. A real
 * withdrawal is a deliberate act and goes through `optOutAction` below (or an
 * inbound STOP), which is the only path on this page that writes a `revoke`.
 *
 * The number is written before consent, never after. A number stored without
 * consent is inert — the transport refuses it — whereas consent recorded
 * against a number we failed to store is a permission for something we can't
 * point at.
 */
export async function savePhoneAction(
  _prev: SavePhoneResult | null,
  formData: FormData,
): Promise<SavePhoneResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const phone = String(formData.get("phone") ?? "").trim();
  const wantsConsent = formData.get("consentStudent") === "on";

  if (!isValidPhone(phone)) {
    return { ok: false, error: "Enter a valid phone number." };
  }

  // `phone` stays exactly as typed — that's what a reviewer reads and what the
  // person recognizes as their own number (see the header of lib/phone.ts). A
  // number we can't normalize still saves: this page has always accepted
  // anything plausible, and narrowing that now would lock out a number we're
  // happy to *call*. Normalization only becomes mandatory below, where consent
  // is recorded, because there is nothing to opt a number into if we can't
  // dial it.
  const phoneE164 = normalizeToE164(phone);
  if (wantsConsent && !phoneE164) {
    return {
      ok: false,
      error:
        "We couldn't read that number well enough to text it. Include the area code, or the country code with a +.",
    };
  }

  const { data: app, error: readErr } = await ownApplication(user.id);
  if (readErr) return { ok: false, error: readErr.message };
  if (!app) {
    return {
      ok: false,
      error: "We couldn't find an application on your account.",
    };
  }

  // The age floor is enforced here as well as in the form, because the form is
  // not the only thing that can post to this action (lib/sms/policy.ts).
  if (wantsConsent && !canOptInAtAge((app.age as number | null) ?? null)) {
    return {
      ok: false,
      error: "Texts aren't available for students under 13 — we'll keep reaching you by email.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("applications")
    .update({ phone })
    .eq("id", app.id)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };

  let granted = false;
  let consentError: string | null = null;
  if (wantsConsent && phoneE164) {
    const evidence = await consentEvidence();
    // Program texts only, and `party: "student"` says whose number this is:
    // grantConsent refuses anything else (lib/sms/policy.ts), and 0106's
    // messaging_consent_no_promo_to_students check refuses it again in the
    // database. Neither is a fallback for the other.
    const res = await grantConsent({
      phone: phoneE164,
      userId: user.id,
      party: "student",
      purposes: ["transactional"],
      // The exact words rendered by phone-form.tsx, from the same constant.
      // The ledger stores the sentence, not a pointer to it, so this is the
      // evidence — passing anything paraphrased here would make the record
      // describe a disclosure nobody read.
      consentText: CONSENT_COPY.studentTransactional,
      source: "dashboard_phone",
      sourceUrl: evidence.sourceUrl,
      ip: evidence.ip,
      userAgent: evidence.userAgent,
    });
    if (res.ok) granted = true;
    else consentError = res.error;
  }

  await logAudit({
    action: "student.phone_saved",
    targetType: "application",
    targetId: app.id as string,
    payload: {
      // Masked: the full number is already on the application row, and an
      // audit trail doesn't need a second copy of it.
      phone: phoneE164 ? maskE164(phoneE164) : null,
      grantedTextConsent: granted,
      consentError,
    },
  });

  revalidatePath("/dashboard/phone");
  // The dashboard's SmsConsentPrompt reads the same two facts.
  revalidatePath("/dashboard");

  if (consentError) {
    // Surfaced, not swallowed. The number saved; the permission didn't, and the
    // person needs to know which of the two happened.
    return {
      ok: false,
      error: `We saved your number, but couldn't turn texts on: ${consentError}`,
    };
  }
  return {
    ok: true,
    notice: granted ? "Saved. Texts are on for this number." : "Saved.",
  };
}

/**
 * Turn texts off for the number on file.
 *
 * The deliberate counterpart to an unticked box: this is the only thing on the
 * page that writes a `revoke` row, and it exists so that "I no longer want
 * these" is a separate, explicit act rather than a side effect of resubmitting
 * a form. The number stays on the application — we still need it to phone
 * someone about a kickoff — and `revokeConsent` leaves the purpose flags alone
 * so a later START restores exactly what was agreed to and no more.
 */
export async function optOutAction(): Promise<SavePhoneResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: app, error: readErr } = await ownApplication(user.id);
  if (readErr) return { ok: false, error: readErr.message };
  if (!app) {
    return { ok: false, error: "We couldn't find an application on your account." };
  }

  const phone = normalizeToE164((app.phone as string | null) ?? null);
  if (!phone) {
    return { ok: false, error: "There's no number on file to turn texts off for." };
  }

  const res = await revokeConsent({
    phone,
    source: "dashboard_phone",
    userId: user.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await logAudit({
    action: "student.sms_opt_out",
    targetType: "application",
    targetId: app.id as string,
    payload: { phone: maskE164(phone) },
  });

  revalidatePath("/dashboard/phone");
  revalidatePath("/dashboard");
  return {
    ok: true,
    notice: "Done — we won't text you again. You can turn texts back on here whenever you like.",
  };
}
