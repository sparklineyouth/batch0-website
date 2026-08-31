import { createAdminClient } from "@/lib/supabase/admin";
import { isStepCondition, type StepConditionKind } from "@/lib/email/catalog";

/**
 * Step gates, evaluated when the mail is about to leave.
 *
 * The timing is the entire feature. A "you haven't paid yet" nudge is queued
 * on day 0 for delivery on day 3; if the gate ran at queue time it would go
 * to everyone, including the person who paid an hour later. Sending someone a
 * payment chase after they've paid is the kind of mistake that gets a
 * programme's mail marked as spam by the people who like it most.
 *
 * Returns `{ send: false, reason }` to skip — the outbox row is marked
 * `skipped` with that reason, so an admin looking at the queue can see the
 * automation working rather than wonder why the count is short.
 */

export type ConditionVerdict = { send: true } | { send: false; reason: string };

export function parseCondition(raw: unknown): StepConditionKind {
  const kind =
    raw && typeof raw === "object" && "kind" in (raw as any)
      ? String((raw as any).kind)
      : "always";
  return isStepCondition(kind) ? kind : "always";
}

export function conditionValue(kind: StepConditionKind): Record<string, any> {
  return kind === "always" ? {} : { kind };
}

export async function evaluateCondition(
  raw: unknown,
  ctx: { userId: string | null; queuedAt: string | null },
): Promise<ConditionVerdict> {
  const kind = parseCondition(raw);
  if (kind === "always") return { send: true };

  // Every gate below asks a question about a *person*. A row with no profile
  // behind it (a parent's address, an outside contact) can't answer it, so it
  // sends — silently dropping mail because we can't check a condition is the
  // worse failure of the two.
  if (!ctx.userId) return { send: true };

  const admin = createAdminClient();

  try {
    switch (kind) {
      case "not_paid": {
        const { count } = await admin
          .from("payments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", ctx.userId)
          .eq("status", "succeeded");
        return (count ?? 0) > 0
          ? { send: false, reason: "They've since paid" }
          : { send: true };
      }
      case "not_enrolled": {
        const { count } = await admin
          .from("enrollments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", ctx.userId);
        return (count ?? 0) > 0
          ? { send: false, reason: "They've since enrolled" }
          : { send: true };
      }
      case "still_applicant": {
        const { data } = await admin
          .from("applications")
          .select("status")
          .eq("user_id", ctx.userId);
        const decided = (data ?? []).some((a: any) =>
          ["accepted", "waitlisted", "rejected", "paid", "enrolled"].includes(a.status),
        );
        return decided
          ? { send: false, reason: "Their application has since been decided" }
          : { send: true };
      }
      case "no_login_since": {
        // `last_sign_in_at` lives on auth.users, not on our profiles table —
        // GoTrue owns it and keeps it current for free, which beats adding a
        // column we'd have to remember to touch on every request.
        if (!ctx.queuedAt) return { send: true };
        const { data } = await admin.auth.admin.getUserById(ctx.userId);
        const seen = data?.user?.last_sign_in_at;
        if (!seen) return { send: true };
        return new Date(seen) > new Date(ctx.queuedAt)
          ? { send: false, reason: "They've signed in since" }
          : { send: true };
      }
    }
  } catch (err) {
    // A gate we couldn't evaluate shouldn't silently eat the email. Log it
    // and send — a duplicate nudge is recoverable, a never-sent acceptance
    // is not.
    console.error("[email/conditions] evaluation failed", kind, err);
    return { send: true };
  }
  return { send: true };
}

/**
 * Evaluate one condition kind across many recipients in a single query.
 *
 * The per-row `evaluateCondition` above is right for a one-off send but wrong
 * for a drain: a 200-person payment nudge ran 200 identical `payments` count
 * queries, one per recipient, inside a cron invocation that also has to send
 * 200 emails. This asks the same question once with an `.in(...)` and returns
 * the set of users who FAIL the gate — i.e. who should be skipped.
 *
 * `no_login_since` is absent on purpose: it reads `auth.users` through
 * `getUserById`, which has no batch form, so it stays per-row.
 */
export async function usersFailingCondition(
  kind: StepConditionKind,
  userIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0 || kind === "always" || kind === "no_login_since") {
    return out;
  }
  const admin = createAdminClient();
  try {
    if (kind === "not_paid") {
      const { data } = await admin
        .from("payments")
        .select("user_id")
        .in("user_id", userIds)
        .eq("status", "succeeded");
      for (const r of data ?? []) out.add((r as any).user_id);
    } else if (kind === "not_enrolled") {
      const { data } = await admin
        .from("enrollments")
        .select("user_id")
        .in("user_id", userIds);
      for (const r of data ?? []) out.add((r as any).user_id);
    } else if (kind === "still_applicant") {
      const { data } = await admin
        .from("applications")
        .select("user_id, status")
        .in("user_id", userIds)
        .in("status", ["accepted", "waitlisted", "rejected", "paid", "enrolled"]);
      for (const r of data ?? []) out.add((r as any).user_id);
    }
  } catch (err) {
    // Same posture as the per-row path: a gate we couldn't evaluate sends
    // rather than silently eating the email.
    console.error("[email/conditions] batch evaluation failed", kind, err);
  }
  return out;
}

/** The reason a batched gate skipped someone, shown on the outbox row. */
export function skipReasonFor(kind: StepConditionKind): string {
  switch (kind) {
    case "not_paid":
      return "They've since paid";
    case "not_enrolled":
      return "They've since enrolled";
    case "still_applicant":
      return "Their application has since been decided";
    default:
      return "A step condition excluded them";
  }
}
