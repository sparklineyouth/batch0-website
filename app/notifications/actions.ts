"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";

/**
 * Both actions revalidate THREE paths, not one.
 *
 * The desktop list at /notifications is no longer the only reader: the
 * installed app has its own inbox at /app/notifications, and the unread badge
 * on the bell at /app/home is a separate count over the same rows. A
 * repo-wide grep for `revalidatePath("/app/` returned zero hits before this —
 * no server action anywhere knew the installed app existed — so an app screen
 * that marked everything read kept showing the old list and the old badge.
 *
 * /app/home is worth the line even though it is `force-dynamic`: what goes
 * stale there is the client Router Cache entry the layout's prefetcher warmed,
 * and that is exactly what revalidatePath expires.
 */
export async function markAllNotificationsRead() {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/notifications");
  revalidatePath("/app/notifications");
  revalidatePath("/app/home");
}

export async function markNotificationRead(id: string) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/notifications");
  revalidatePath("/app/notifications");
  revalidatePath("/app/home");
}
