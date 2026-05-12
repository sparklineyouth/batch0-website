import { createAdminClient } from "@/lib/supabase/admin";

export type NotifyArgs = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /**
   * Optional dedupe key. If provided, the row is upserted on
   * (user_id, dedupe_key) — so retrying the same fan-out (cron retries,
   * announcement re-broadcasts) won't create duplicates.
   * A partial unique index on (user_id, dedupe_key) where dedupe_key
   * is not null backs this (migration 0012).
   */
  dedupeKey?: string;
};

/**
 * In-app notification fan-out. Failures are swallowed.
 */
export async function notify(args: NotifyArgs) {
  try {
    const admin = createAdminClient();
    const row = {
      user_id: args.userId,
      type: args.type,
      title: args.title,
      body: args.body ?? null,
      link: args.link ?? null,
      dedupe_key: args.dedupeKey ?? null,
    };
    if (args.dedupeKey) {
      await admin
        .from("notifications")
        .upsert(row, {
          onConflict: "user_id,dedupe_key",
          ignoreDuplicates: true,
        });
    } else {
      await admin.from("notifications").insert(row);
    }
  } catch (err) {
    console.error("[notify] failed:", args.type, err);
  }
}

export async function notifyMany(args: NotifyArgs[]) {
  if (args.length === 0) return;
  try {
    const admin = createAdminClient();
    const rows = args.map((a) => ({
      user_id: a.userId,
      type: a.type,
      title: a.title,
      body: a.body ?? null,
      link: a.link ?? null,
      dedupe_key: a.dedupeKey ?? null,
    }));
    // If any caller supplied a dedupe_key, route through upsert. Mixed
    // batches are uncommon but safe — rows without a dedupe_key skip
    // the partial unique index entirely.
    const hasDedup = rows.some((r) => r.dedupe_key);
    if (hasDedup) {
      await admin.from("notifications").upsert(rows, {
        onConflict: "user_id,dedupe_key",
        ignoreDuplicates: true,
      });
    } else {
      await admin.from("notifications").insert(rows);
    }
  } catch (err) {
    console.error("[notifyMany] failed:", err);
  }
}
