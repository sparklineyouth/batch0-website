"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/notifications";
import { isoWeekStart } from "@/lib/week";
import { getDiscordSettings, postChannelMessage } from "@/lib/discord";

export type CheckinInput = {
  accomplished: string;
  next_up: string;
  blockers: string;
  is_milestone?: boolean;
};

export async function submitCheckin(input: CheckinInput) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const accomplished = input.accomplished.trim();
  const next_up = input.next_up.trim();
  const blockers = input.blockers.trim();
  if (!accomplished && !next_up && !blockers) {
    throw new Error("Add at least one section before submitting.");
  }
  if (
    accomplished.length > 4000 ||
    next_up.length > 4000 ||
    blockers.length > 4000
  ) {
    throw new Error("Each section is capped at 4000 characters.");
  }

  // Enrollment is required: check-ins are a cohort-only feature. The
  // sidebar hides the link pre-enrollment but the route is reachable by
  // URL, so reject on the server too.
  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("cohort_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!enrollment) {
    throw new Error(
      "You need to be enrolled in a cohort to post a weekly check-in.",
    );
  }

  const week_start = isoWeekStart();
  const is_milestone = !!input.is_milestone;
  const payload = {
    user_id: user.id,
    cohort_id: enrollment.cohort_id ?? null,
    week_start,
    accomplished: accomplished || null,
    next_up: next_up || null,
    blockers: blockers || null,
    is_milestone,
  };

  const { error } = await supabase
    .from("student_checkins")
    .upsert(payload, { onConflict: "user_id,week_start" });
  if (error) throw new Error(error.message);

  // Milestone? Cross-post to #wins. Best-effort.
  if (is_milestone) {
    try {
      const settings = await getDiscordSettings();
      if (settings.winsChannelId) {
        const admin = createAdminClient();
        const { data: profile } = await admin
          .from("profiles")
          .select("full_name, discord_user_id")
          .eq("id", user.id)
          .maybeSingle();
        const who = profile?.discord_user_id
          ? `<@${profile.discord_user_id}>`
          : profile?.full_name ?? "A student";
        await postChannelMessage(settings.winsChannelId, {
          content: `🎉 **${who}** just hit a milestone:\n${(accomplished || next_up || "Big moment.").slice(0, 1500)}`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      console.error("[checkin] milestone crosspost failed", err);
    }
  }

  // Best-effort: ping every mentor + admin so they know there's
  // something new to read.
  try {
    const admin = createAdminClient();
    const { data: staff } = await admin
      .from("profiles")
      .select("id")
      .in("role", ["mentor", "admin"]);
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", user.id)
      .maybeSingle();
    const name = profile?.full_name ?? profile?.email ?? "A student";
    for (const s of staff ?? []) {
      if (s.id === user.id) continue;
      await notify({
        userId: s.id,
        type: "checkin_submitted",
        title: `${name} posted this week's check-in`,
        body: accomplished ? accomplished.slice(0, 160) : null,
        link: `/mentor/checkins?week=${week_start}`,
      });
    }
  } catch (err) {
    console.error("[checkin] staff notify failed", err);
  }

  revalidatePath("/dashboard/checkin");
  revalidatePath("/mentor/checkins");
}

export async function postCheckinFeedback(
  checkinId: string,
  body: string,
): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const trimmed = body.trim();
  if (!trimmed) throw new Error("Empty feedback");
  if (trimmed.length > 4000) throw new Error("Feedback too long");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || (profile.role !== "mentor" && profile.role !== "admin")) {
    throw new Error("Forbidden");
  }

  const admin = createAdminClient();
  const { data: checkin } = await admin
    .from("student_checkins")
    .select("id, user_id, week_start")
    .eq("id", checkinId)
    .maybeSingle();
  if (!checkin) throw new Error("Check-in not found");

  const { error } = await admin.from("checkin_feedback").insert({
    checkin_id: checkinId,
    author_id: user.id,
    body: trimmed,
  });
  if (error) throw new Error(error.message);

  await notify({
    userId: checkin.user_id,
    type: "checkin_feedback",
    title: `${profile.full_name ?? "Your mentor"} left feedback on your check-in`,
    body: trimmed.slice(0, 200),
    link: "/dashboard/checkin",
  });

  revalidatePath("/dashboard/checkin");
  revalidatePath("/mentor/checkins");
}
