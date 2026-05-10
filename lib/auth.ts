import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/types";

export async function getUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

export async function getProfile(): Promise<Profile | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) return profile as Profile;

  // Self-heal: profile row is missing (migration trigger didn't fire,
  // profile was deleted, etc.). Create one with the service role client
  // so RLS doesn't block, and so the dashboard never has to redirect
  // back to /login (which would cause an infinite redirect loop with
  // the middleware that bounces signed-in users away from /login).
  try {
    const admin = createAdminClient();
    const { data: created } = await admin
      .from("profiles")
      .upsert(
        {
          id: user.id,
          email: user.email ?? "",
          full_name:
            (user.user_metadata?.full_name as string | undefined) ?? "",
        },
        { onConflict: "id" },
      )
      .select("*")
      .maybeSingle();
    if (created) return created as Profile;
  } catch (err) {
    console.error("[auth] profile self-heal failed:", err);
  }

  // Last-resort synthesized profile so the UI can render and the user
  // sees the app instead of a redirect loop. The DB is the source of
  // truth — this only fires if the DB is unreachable or the schema is
  // missing, which an admin needs to fix.
  return {
    id: user.id,
    email: user.email ?? "",
    full_name: (user.user_metadata?.full_name as string | undefined) ?? null,
    role: "student",
    stripe_customer_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function requireAdmin() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin") redirect("/dashboard");
  return profile;
}

export async function requireStaff() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin" && profile.role !== "professor") {
    redirect("/dashboard");
  }
  return profile;
}
