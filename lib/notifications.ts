import { createAdminClient } from "@/lib/supabase/admin";

export type NotifyArgs = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
};

/**
 * In-app notification fan-out. Failures are swallowed.
 */
export async function notify(args: NotifyArgs) {
  try {
    const admin = createAdminClient();
    await admin.from("notifications").insert({
      user_id: args.userId,
      type: args.type,
      title: args.title,
      body: args.body ?? null,
      link: args.link ?? null,
    });
  } catch (err) {
    console.error("[notify] failed:", args.type, err);
  }
}

export async function notifyMany(args: NotifyArgs[]) {
  if (args.length === 0) return;
  try {
    const admin = createAdminClient();
    await admin.from("notifications").insert(
      args.map((a) => ({
        user_id: a.userId,
        type: a.type,
        title: a.title,
        body: a.body ?? null,
        link: a.link ?? null,
      })),
    );
  } catch (err) {
    console.error("[notifyMany] failed:", err);
  }
}
