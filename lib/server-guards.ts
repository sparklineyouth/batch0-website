import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";

/**
 * Server-action / route-handler guards. These throw `Error` so server
 * actions can let the error bubble up to the client transition.
 *
 * Use `assertAdmin()` for write operations on financial/admin data
 * (cohorts, payments, settings, role changes, application decisions).
 *
 * Use `assertStaff()` for write operations on program content (modules,
 * lessons, mentor feedback on student/team work) — admin AND mentor are
 * allowed.
 */

async function getActor(): Promise<{ userId: string; role: Role }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return { userId: user.id, role: (profile?.role as Role) ?? "student" };
}

export async function assertAdmin(): Promise<{ userId: string }> {
  const actor = await getActor();
  if (actor.role !== "admin") throw new Error("Forbidden");
  return { userId: actor.userId };
}

export async function assertStaff(): Promise<{
  userId: string;
  role: Role;
}> {
  const actor = await getActor();
  if (actor.role !== "admin" && actor.role !== "mentor") {
    throw new Error("Forbidden");
  }
  return actor;
}

export async function assertSelf(): Promise<{ userId: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return { userId: user.id };
}
