"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidPhone } from "@/lib/phone";

export type SavePhoneResult = { ok: boolean; error?: string };

/**
 * Save the signed-in student's phone number onto their most-recent
 * application.
 *
 * Written through the SERVICE-ROLE client on purpose: the "applications self
 * update draft" RLS policy only lets a student update their own row while it's
 * still a draft, and the people this page exists for were accepted long ago.
 * So the user client can't write here. The admin client can — and the write is
 * hard-scoped to `user_id = user.id`, the id from the verified session, so it
 * can only ever touch the caller's own application no matter what's posted.
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
  if (!isValidPhone(phone)) {
    return { ok: false, error: "Enter a valid phone number." };
  }

  const admin = createAdminClient();
  // Their most-recent application — the same row /dashboard/accepted reads,
  // so what they enter here is what the rest of the dashboard shows.
  const { data: app, error: readErr } = await admin
    .from("applications")
    .select("id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!app) {
    return {
      ok: false,
      error: "We couldn't find an application on your account.",
    };
  }

  const { error } = await admin
    .from("applications")
    .update({ phone })
    .eq("id", app.id)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/phone");
  return { ok: true };
}
