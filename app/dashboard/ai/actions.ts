"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";

export async function createConversation() {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_conversations")
    .insert({ user_id: userId })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ai");
  return data!.id as string;
}

export async function deleteConversation(id: string) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { error } = await admin
    .from("ai_conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ai");
}

export async function renameConversation(id: string, title: string) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { error } = await admin
    .from("ai_conversations")
    .update({ title: title.trim().slice(0, 120) || null })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ai");
}

export async function saveAiContext(
  ctx: Record<string, string>,
): Promise<void> {
  const { userId } = await assertSelf();
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    const tk = k.trim().slice(0, 60);
    const tv = String(v ?? "")
      .trim()
      .slice(0, 1000);
    if (tk && tv) cleaned[tk] = tv;
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ ai_context: cleaned })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/ai");
}
