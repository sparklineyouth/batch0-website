"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import type { Role } from "@/lib/types";

const VALID_ROLES: Role[] = [
  "student",
  "professor",
  "admin",
  "mentor",
  "investor",
];

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || profile.role !== "admin") throw new Error("Forbidden");
  return user.id;
}

export async function changeUserRole(userId: string, role: Role) {
  const actorId = await ensureAdmin();
  if (!VALID_ROLES.includes(role)) throw new Error("Invalid role");
  if (userId === actorId && role !== "admin") {
    throw new Error("You can't downgrade your own admin role.");
  }
  const admin = createAdminClient();
  const { data: prev } = await admin
    .from("profiles")
    .select("role, email")
    .eq("id", userId)
    .single();
  const { error } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "user.role_changed",
    targetType: "profile",
    targetId: userId,
    payload: { from: prev?.role ?? null, to: role, email: prev?.email },
  });
  revalidatePath("/admin/students");
}
