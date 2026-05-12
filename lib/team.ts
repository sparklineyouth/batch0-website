import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Returns the team the user is currently a member of (if any). Students
 * are 1:1 with a team within a cohort.
 */
export async function getMyTeam(userId: string) {
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("team_members")
    .select("team_id, role, team:teams(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!membership) return null;
  const team = Array.isArray(membership.team)
    ? membership.team[0]
    : membership.team;
  return team
    ? { ...(team as any), my_role: (membership as any).role as string }
    : null;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Reserves a unique team slug within a cohort. Falls back to appending a
 * suffix if there's a collision.
 */
export async function reserveTeamSlug(
  cohortId: string,
  base: string,
): Promise<string> {
  const admin = createAdminClient();
  const root = slugify(base) || "team";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i}`;
    const { data } = await admin
      .from("teams")
      .select("id")
      .eq("cohort_id", cohortId)
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}
