"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";
import { refuse, runAction, type ActionResult } from "@/lib/action-result";
import { introRequestDecision } from "@/lib/intro-requests";

async function getRole(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  // Thrown, not read as "no role": "Investors only." is a refusal, and
  // refusals aren't logged, so a failed read would vanish behind it.
  if (error) throw new Error(error.message);
  return data?.role ?? null;
}

export type ScoreInput = {
  teamId: string;
  problem: number | null;
  traction: number | null;
  team_score: number | null;
  ask: number | null;
  notes: string | null;
};

export async function upsertPitchScore(
  input: ScoreInput,
): Promise<ActionResult> {
  return runAction({ name: "upsertPitchScore" }, async () => {
    const { userId } = await assertSelf();
    const role = await getRole(userId);
    if (role !== "investor" && role !== "admin") {
      throw new Error("Only investors or admins can score pitches.");
    }
    function check(n: number | null) {
      if (n == null) return null;
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new Error("Scores must be 1–5.");
      }
      return n;
    }
    const admin = createAdminClient();
    const { error } = await admin
      .from("pitch_scores")
      .upsert(
        {
          team_id: input.teamId,
          scorer_id: userId,
          problem: check(input.problem),
          traction: check(input.traction),
          team_score: check(input.team_score),
          ask: check(input.ask),
          notes: (input.notes ?? "").trim().slice(0, 2000) || null,
        },
        { onConflict: "team_id,scorer_id" },
      );
    if (error) throw new Error(error.message);
    revalidatePath(`/investor/teams/${input.teamId}`);
    revalidatePath("/admin/demo-day");
  });
}

// Intros
export async function createIntroRequest(input: {
  teamId: string;
  message: string;
}): Promise<ActionResult> {
  return runAction({ name: "createIntroRequest" }, async () => {
    const { userId } = await assertSelf();
    const role = await getRole(userId);
    // Admins can view the investor surface but should not file intros —
    // intros are recorded against a real investor profile.
    if (role !== "investor") {
      refuse(
        role === "admin"
          ? "Admins can't file intros from view-as mode — sign in as the investor."
          : "Investors only.",
      );
    }
    const admin = createAdminClient();
    const [{ data: team, error: teamErr }, { data: existing, error: existingErr }, { count: openCount, error: countErr }] =
      await Promise.all([
        admin.from("teams").select("name").eq("id", input.teamId).maybeSingle(),
        admin
          .from("intro_requests")
          .select("id, status")
          .eq("investor_id", userId)
          .eq("team_id", input.teamId)
          .maybeSingle(),
        admin
          .from("intro_requests")
          .select("id", { count: "exact", head: true })
          .eq("investor_id", userId)
          .eq("status", "requested"),
      ]);
    if (teamErr) throw new Error(teamErr.message);
    if (!team) {
      refuse("Team not found.");
    }
    if (existingErr) throw new Error(existingErr.message);
    if (countErr) throw new Error(countErr.message);

    // One investor can't flood the admin queue, and a request the team has
    // already moved on is never reset to new (lib/intro-requests.ts).
    const decision = introRequestDecision({ existing, openCount: openCount ?? 0 });
    if (decision.kind === "refuse") refuse(decision.message);
    const message = (input.message ?? "").trim().slice(0, 1000) || null;
    if (decision.kind === "update-message") {
      const { error } = await admin
        .from("intro_requests")
        .update({ message })
        .eq("id", existing!.id)
        // Only while it is still waiting: an admin acting on it a moment ago wins.
        .eq("status", "requested");
      if (error) throw new Error(error.message);
      revalidatePath(`/investor/teams/${input.teamId}`);
      revalidatePath("/investor/intros");
      revalidatePath("/admin/intros");
      return;
    }
    const { error } = await admin
      .from("intro_requests")
      // ignoreDuplicates: a double-submit racing this one leaves the first
      // row as it is instead of overwriting whatever the team did with it.
      .upsert(
        { investor_id: userId, team_id: input.teamId, message, status: "requested" },
        { onConflict: "investor_id,team_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(error.message);

    // Ping admins. Failures here are swallowed — the request is filed.
    try {
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name, email")
        .eq("id", userId)
        .maybeSingle();
      const who = profile?.full_name ?? profile?.email ?? "An investor";
      const { data: admins } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "admin");
      for (const a of admins ?? []) {
        await notify({
          userId: a.id,
          type: "intro_request",
          title: `${who} wants an intro to ${team?.name ?? "a team"}`,
          body: (input.message ?? "").slice(0, 200) || null,
          link: "/admin/intros",
        });
      }
    } catch (err) {
      console.error("[createIntroRequest] notify failed:", err);
    }

    revalidatePath(`/investor/teams/${input.teamId}`);
    revalidatePath("/investor/intros");
    revalidatePath("/admin/intros");
  });
}
