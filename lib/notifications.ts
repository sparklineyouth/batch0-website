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
   * A unique index on (user_id, dedupe_key) backs this. 0012 first made it
   * partial (`where dedupe_key is not null`), which an `on conflict` with a
   * bare column list cannot target, so every deduped insert failed with 42P10;
   * migration 0090 replaced it with a plain one. NULL keys are still distinct
   * in a unique index, so rows without a key never collide.
   */
  dedupeKey?: string;
};

/**
 * In-app notification fan-out. Failures are logged and swallowed: a bell is
 * a side effect of the thing it reports, never a reason for it to fail.
 *
 * supabase-js returns a failed write as `{ error }` rather than throwing, so
 * the try/catch alone can't see one. Checking it is what turned "deduped bells
 * silently never arrive" (the partial-index bug above) from invisible into a
 * log line — keep the check even though nothing here can act on it.
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
    const { error } = args.dedupeKey
      ? await admin.from("notifications").upsert(row, {
          onConflict: "user_id,dedupe_key",
          ignoreDuplicates: true,
        })
      : await admin.from("notifications").insert(row);
    if (error) console.error("[notify] failed:", args.type, error.message);
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
    // batches are uncommon but safe — rows without a dedupe_key never
    // conflict, because NULLs are distinct in the unique index.
    const hasDedup = rows.some((r) => r.dedupe_key);
    const { error } = hasDedup
      ? await admin.from("notifications").upsert(rows, {
          onConflict: "user_id,dedupe_key",
          ignoreDuplicates: true,
        })
      : await admin.from("notifications").insert(rows);
    if (error) {
      console.error(
        "[notifyMany] failed:",
        args[0]?.type,
        `(${args.length} rows)`,
        error.message,
      );
    }
  } catch (err) {
    console.error("[notifyMany] failed:", err);
  }
}
