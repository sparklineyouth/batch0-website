import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth";

/**
 * Append-only audit log for sensitive admin actions. Failures are
 * swallowed (logged) — auditing must never break the operation it
 * tracks. Caller is responsible for providing a meaningful action +
 * payload.
 */

/**
 * Who a batch of audit rows is attributed to. Both a Supabase `User`
 * (`id`) and a lib/server-guards actor (`userId`) satisfy it as-is; null
 * records a system actor (webhooks, crons). Email lands on the rows only
 * when the caller has one — guards don't carry it.
 */
export type AuditActor =
  | { id: string; email?: string | null }
  | { userId: string; email?: string | null }
  | null;

function actorId(actor: AuditActor): string | null {
  if (!actor) return null;
  return "id" in actor ? actor.id : actor.userId;
}

type AuditEntry = {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, any> | null;
};

export async function logAudit(args: AuditEntry) {
  try {
    // Request-cached — the guard that authorized this mutation already
    // resolved the same user, so attributing the row costs no extra
    // network hop. Resolves null in webhook/cron contexts, recording a
    // system actor.
    const user = await getUser();
    await insertRows(user ? { id: user.id, email: user.email ?? null } : null, [
      args,
    ]);
  } catch (err) {
    console.error("[audit] failed to log:", args.action, err);
  }
}

/**
 * One insert for a whole batch. For bulk operations that would otherwise
 * call logAudit() in a loop — 200 role changes should cost one audit round
 * trip, not 200. The actor is a parameter because bulk callers already hold
 * one from their guard; pass null for system actions.
 */
export async function logAuditMany(actor: AuditActor, entries: AuditEntry[]) {
  if (entries.length === 0) return;
  try {
    await insertRows(actor, entries);
  } catch (err) {
    console.error(
      "[audit] failed to log batch:",
      entries[0]?.action,
      `(${entries.length} rows)`,
      err,
    );
  }
}

async function insertRows(actor: AuditActor, entries: AuditEntry[]) {
  const admin = createAdminClient();
  await admin.from("audit_log").insert(
    entries.map((e) => ({
      actor_id: actorId(actor),
      actor_email: actor?.email ?? null,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      payload: e.payload ?? null,
    })),
  );
}
