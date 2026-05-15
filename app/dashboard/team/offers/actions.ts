"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { logAudit } from "@/lib/audit";
import { renderSafeDoc } from "@/lib/safe-doc";

function ip(): string | null {
  // Vercel proxies the originating address as the first hop in
  // x-forwarded-for. Falls back to x-real-ip behind other proxies.
  // We trim to the first comma-separated entry to avoid logging the
  // entire proxy chain (which can be PII-leaky and useless for audit).
  const h = headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? null;
  return h.get("x-real-ip") ?? null;
}

export type CreateOfferInput = {
  teamId: string;
  amountCents: number;
  valuationCapCents: number | null;
  discountPct: number | null;
  mfn: boolean;
  proRata: boolean;
  notes: string | null;
  signatureName: string;
};

export async function createOffer(input: CreateOfferInput): Promise<string> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name, email")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || (profile.role !== "investor" && profile.role !== "admin")) {
    throw new Error("Only investors can send SAFE offers");
  }
  if (input.amountCents < 100) throw new Error("Amount must be at least $1");
  if (!input.signatureName.trim()) throw new Error("Type your name to sign");

  const { data: team } = await admin
    .from("teams")
    .select("id, name")
    .eq("id", input.teamId)
    .maybeSingle();
  if (!team) throw new Error("Team not found");

  const document = renderSafeDoc({
    investorName: profile.full_name ?? profile.email ?? "Investor",
    teamName: team.name,
    amountCents: input.amountCents,
    valuationCapCents: input.valuationCapCents,
    discountPct: input.discountPct,
    mfn: input.mfn,
    proRata: input.proRata,
    notes: input.notes,
  });

  const now = new Date().toISOString();
  const signerIp = ip();
  const { data: offer, error } = await admin
    .from("safe_offers")
    .insert({
      investor_id: user.id,
      team_id: input.teamId,
      amount_cents: input.amountCents,
      valuation_cap_cents: input.valuationCapCents,
      discount_pct: input.discountPct,
      mfn: input.mfn,
      pro_rata: input.proRata,
      notes: input.notes,
      document_md: document,
      status: "sent",
      sent_at: now,
      investor_signed_at: now,
      investor_signature_name: input.signatureName.trim(),
      investor_signature_ip: signerIp,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  // Email every team member.
  const { data: members } = await admin
    .from("team_members")
    .select("user:profiles(email)")
    .eq("team_id", input.teamId);
  const emails = (members ?? [])
    .map((m: any) => {
      const u = Array.isArray(m.user) ? m.user[0] : m.user;
      return u?.email;
    })
    .filter((e: string | undefined): e is string => Boolean(e));
  if (emails.length > 0) {
    const tpl = Templates.safeOfferSent({
      teamName: team.name,
      investorName: profile.full_name ?? profile.email ?? null,
      amountCents: input.amountCents,
      valuationCapCents: input.valuationCapCents,
      offerId: offer!.id,
    });
    for (const to of emails) {
      await sendEmail({ to, subject: tpl.subject, html: tpl.html });
    }
  }

  await logAudit({
    action: "safe_offer.sent",
    targetType: "team",
    targetId: input.teamId,
    payload: {
      offer_id: offer!.id,
      amount_cents: input.amountCents,
      cap_cents: input.valuationCapCents,
      mfn: input.mfn,
      pro_rata: input.proRata,
    },
  });
  revalidatePath(`/investor/teams/${input.teamId}`);
  revalidatePath(`/dashboard/team/offers`);
  return offer!.id;
}

export async function counterSignOffer(args: {
  offerId: string;
  signatureName: string;
}): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  if (!args.signatureName.trim()) throw new Error("Type your name to sign");

  const admin = createAdminClient();
  const { data: offer } = await admin
    .from("safe_offers")
    .select("id, team_id, status, investor_id")
    .eq("id", args.offerId)
    .maybeSingle();
  if (!offer) throw new Error("Offer not found");
  if (offer.status !== "sent") {
    throw new Error("This offer can't be signed right now.");
  }

  const { data: membership } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", offer.team_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) throw new Error("You're not on this team");

  const now = new Date().toISOString();
  const signerIp = ip();
  const { error } = await admin
    .from("safe_offers")
    .update({
      status: "accepted",
      team_signed_at: now,
      team_signed_by: user.id,
      team_signature_name: args.signatureName.trim(),
      team_signature_ip: signerIp,
    })
    .eq("id", args.offerId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "safe_offer.countersigned",
    targetType: "safe_offer",
    targetId: args.offerId,
    payload: { signer: user.id, team_id: offer.team_id },
  });

  // Notify the investor that the team accepted.
  const [{ data: inv }, { data: team }] = await Promise.all([
    admin
      .from("profiles")
      .select("email, full_name")
      .eq("id", offer.investor_id)
      .maybeSingle(),
    admin
      .from("teams")
      .select("name")
      .eq("id", offer.team_id)
      .maybeSingle(),
  ]);
  if (inv?.email) {
    await sendEmail({
      to: inv.email,
      subject: `Counter-signed: ${team?.name ?? "team"} accepted your SAFE`,
      html: `<p>${team?.name ?? "The team"} has counter-signed the SAFE offer. Full audit trail is on the offer page.</p>`,
    });
  }

  revalidatePath(`/dashboard/team/offers/${args.offerId}`);
  revalidatePath(`/dashboard/team/offers`);
  revalidatePath(`/investor/teams/${offer.team_id}`);
}

export async function declineOffer(offerId: string, reason: string | null) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const admin = createAdminClient();
  const { data: offer } = await admin
    .from("safe_offers")
    .select("id, team_id, status")
    .eq("id", offerId)
    .maybeSingle();
  if (!offer) throw new Error("Offer not found");
  if (offer.status !== "sent") {
    throw new Error("This offer is already resolved.");
  }
  const { data: membership } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", offer.team_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) throw new Error("You're not on this team");

  const { error } = await admin
    .from("safe_offers")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      notes: reason
        ? `${reason}\n\n---\n(declined by ${user.email})`
        : undefined,
    })
    .eq("id", offerId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "safe_offer.declined",
    targetType: "safe_offer",
    targetId: offerId,
    payload: { reason },
  });
  revalidatePath(`/dashboard/team/offers/${offerId}`);
  revalidatePath(`/dashboard/team/offers`);
}

export async function withdrawOffer(offerId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const admin = createAdminClient();
  const { data: offer } = await admin
    .from("safe_offers")
    .select("id, status, investor_id")
    .eq("id", offerId)
    .maybeSingle();
  if (!offer) throw new Error("Offer not found");
  if (offer.investor_id !== user.id) {
    throw new Error("Only the offering investor can withdraw");
  }
  if (offer.status === "accepted" || offer.status === "declined") {
    throw new Error("Already resolved");
  }
  const { error } = await admin
    .from("safe_offers")
    .update({
      status: "withdrawn",
      withdrawn_at: new Date().toISOString(),
    })
    .eq("id", offerId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "safe_offer.withdrawn",
    targetType: "safe_offer",
    targetId: offerId,
  });
  revalidatePath(`/dashboard/team/offers/${offerId}`);
}
