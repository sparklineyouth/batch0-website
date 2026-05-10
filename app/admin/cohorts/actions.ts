"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || (profile.role !== "admin" && profile.role !== "teacher")) {
    throw new Error("Forbidden");
  }
}

export type CohortInput = {
  id?: string;
  name: string;
  starts_on?: string | null;
  ends_on?: string | null;
  capacity: number;
  status: "upcoming" | "active" | "completed" | "cancelled";
  price_cents: number;
};

export async function saveCohort(input: CohortInput) {
  await ensureAdmin();
  const admin = createAdminClient();
  const payload = {
    name: input.name,
    starts_on: input.starts_on || null,
    ends_on: input.ends_on || null,
    capacity: input.capacity,
    status: input.status,
    price_cents: input.price_cents,
  };
  if (input.id) {
    const { error } = await admin.from("cohorts").update(payload).eq("id", input.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from("cohorts").insert(payload);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/admin/cohorts");
}

export async function deleteCohort(id: string) {
  await ensureAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("cohorts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/cohorts");
}
