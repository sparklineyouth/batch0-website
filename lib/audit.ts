import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Append-only audit log for sensitive admin actions. Failures are
 * swallowed (logged) — auditing must never break the operation it
 * tracks. Caller is responsible for providing a meaningful action +
 * payload.
 */
export async function logAudit(args: {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, any> | null;
}) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      actor_id: user?.id ?? null,
      actor_email: user?.email ?? null,
      action: args.action,
      target_type: args.targetType ?? null,
      target_id: args.targetId ?? null,
      payload: args.payload ?? null,
    });
  } catch (err) {
    console.error("[audit] failed to log:", args.action, err);
  }
}
