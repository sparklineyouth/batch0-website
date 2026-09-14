"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { EMOJIS, type Emoji } from "./emoji";

/**
 * Toggle the caller's reaction on an announcement. The DB enforces
 * uniqueness on (announcement, user, emoji), so toggling just inserts
 * or deletes accordingly. Uses the user-scoped supabase client so RLS
 * (not the service role) does the auth — the policy already restricts
 * inserts to `user_id = auth.uid()`.
 */
export async function toggleReaction(input: {
  announcementId: string;
  emoji: Emoji;
}) {
  if (!EMOJIS.includes(input.emoji)) throw new Error("Invalid emoji.");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: existing } = await supabase
    .from("announcement_reactions")
    .select("user_id")
    .eq("announcement_id", input.announcementId)
    .eq("user_id", user.id)
    .eq("emoji", input.emoji)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("announcement_reactions")
      .delete()
      .eq("announcement_id", input.announcementId)
      .eq("user_id", user.id)
      .eq("emoji", input.emoji);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("announcement_reactions").insert({
      announcement_id: input.announcementId,
      user_id: user.id,
      emoji: input.emoji,
    });
    if (error) throw new Error(error.message);
  }

  revalidatePath("/dashboard/announcements");
}
