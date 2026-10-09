"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import {
  defaultImportance,
  isImportanceValue,
  type Importance,
} from "@/lib/notification-importance";

/**
 * Mark the signed-in person's unread notifications read.
 *
 * `types`, when given, narrows it to those notification types — that's how
 * "Mark all read" inside one /notifications tab clears that tab without
 * touching the other one. Omitted (the bell dropdown, which shows everything)
 * it means every unread notification.
 */
export async function markAllNotificationsRead(types?: string[]) {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  let q = admin
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);
  if (types) {
    // An empty list would be a no-op update across every type under some
    // clients; bail out rather than depending on that.
    if (types.length === 0) return;
    q = q.in("type", types);
  }
  const { error } = await q;
  if (error) throw new Error(error.message);
  revalidatePath("/notifications");
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
}

/**
 * Reclassify one notification type for the signed-in person.
 *
 * Storing the default would work, but we delete instead: the table is then
 * exactly "the types this person disagrees with us about", which is what makes
 * `resetNotificationImportance` a one-line delete and keeps a shipped change
 * to a default from being silently overridden by a row that only ever agreed
 * with it. See migration 0091.
 */
export async function setNotificationImportance(
  type: string,
  importance: Importance,
) {
  const { userId } = await assertSelf();
  const t = type.trim();
  if (!t) throw new Error("Missing notification type");
  if (!isImportanceValue(importance)) {
    throw new Error("Invalid importance");
  }
  const admin = createAdminClient();

  if (importance === defaultImportance(t)) {
    const { error } = await admin
      .from("notification_importance")
      .delete()
      .eq("user_id", userId)
      .eq("type", t);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin
      .from("notification_importance")
      .upsert(
        {
          user_id: userId,
          type: t,
          importance,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,type" },
      );
    if (error) throw new Error(error.message);
  }
  revalidatePath("/notifications");
}

/** Drop every override, putting the person back on the shipped defaults. */
export async function resetNotificationImportance() {
  const { userId } = await assertSelf();
  const admin = createAdminClient();
  const { error } = await admin
    .from("notification_importance")
    .delete()
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/notifications");
}
