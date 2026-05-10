"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const ApplicationSchema = z.object({
  full_name: z.string().min(1, "Required").max(120),
  age: z.coerce.number().int().min(10).max(25),
  grade: z.string().max(40).optional().or(z.literal("")),
  school: z.string().max(160).optional().or(z.literal("")),
  city: z.string().max(120).optional().or(z.literal("")),
  country: z.string().max(120).optional().or(z.literal("")),
  parent_email: z.string().email("Must be a valid email").optional().or(z.literal("")),
  why_join: z.string().min(40, "Tell us at least a couple sentences").max(2000),
  startup_idea: z.string().max(2000).optional().or(z.literal("")),
  experience: z.string().max(2000).optional().or(z.literal("")),
  hours_per_week: z.coerce.number().int().min(0).max(168).optional(),
  referral_source: z.string().max(200).optional().or(z.literal("")),
});

type ActionResult = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

async function upsertApplication(formData: FormData, submit: boolean): Promise<ActionResult> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const raw = Object.fromEntries(formData.entries());
  const parsed = ApplicationSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "_";
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }

  // Find active/upcoming cohort to attach to
  const { data: cohort } = await supabase
    .from("cohorts")
    .select("id")
    .in("status", ["upcoming", "active"])
    .order("starts_on", { ascending: true })
    .limit(1)
    .maybeSingle();

  const payload = {
    user_id: user.id,
    cohort_id: cohort?.id ?? null,
    status: submit ? "submitted" : "draft",
    submitted_at: submit ? new Date().toISOString() : null,
    ...parsed.data,
    parent_email: parsed.data.parent_email || null,
    grade: parsed.data.grade || null,
    school: parsed.data.school || null,
    city: parsed.data.city || null,
    country: parsed.data.country || null,
    startup_idea: parsed.data.startup_idea || null,
    experience: parsed.data.experience || null,
    referral_source: parsed.data.referral_source || null,
  };

  // Upsert by (user_id, cohort_id) — but if cohort is null we just upsert by user
  const { data: existing } = await supabase
    .from("applications")
    .select("id, status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Once submitted, the app is locked from self-edits.
    if (["submitted", "accepted", "rejected", "paid", "enrolled"].includes(existing.status)) {
      return { ok: false, error: "Your application is already in review or decided." };
    }
    const { error } = await supabase
      .from("applications")
      .update(payload)
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("applications").insert(payload);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/application");
  return { ok: true };
}

export async function saveDraftAction(_: ActionResult | null, formData: FormData) {
  return upsertApplication(formData, false);
}

export async function submitApplicationAction(_: ActionResult | null, formData: FormData) {
  const result = await upsertApplication(formData, true);
  if (result.ok) redirect("/dashboard/application?submitted=1");
  return result;
}
