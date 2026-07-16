"use server";
import { createClient } from "@/lib/supabase/server";
import type { FlowAnswers } from "@/lib/flows";

/**
 * Persist a student's position + answers in a flow. Runs as the signed-in
 * user, so RLS ("flow progress own") is the enforcement — no admin client.
 * Called after every step transition; the player treats it as fire-and-forget.
 */
export async function saveFlowProgress(input: {
  flowId: string;
  answers: FlowAnswers;
  currentStep: string | null;
  completed: boolean;
  /** Restarting clears completion; otherwise a finished flow stays finished. */
  restart?: boolean;
}): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const answers = input.answers ?? {};
  if (JSON.stringify(answers).length > 100_000) {
    throw new Error("Answers too large");
  }

  const { data: existing } = await supabase
    .from("flow_progress")
    .select("completed_at")
    .eq("flow_id", input.flowId)
    .eq("user_id", user.id)
    .maybeSingle();

  const completedAt = input.completed
    ? new Date().toISOString()
    : input.restart
      ? null
      : (existing?.completed_at ?? null);

  const { error } = await supabase.from("flow_progress").upsert(
    {
      flow_id: input.flowId,
      user_id: user.id,
      answers,
      current_step: input.currentStep,
      completed_at: completedAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "flow_id,user_id" },
  );
  if (error) throw new Error(error.message);
}
