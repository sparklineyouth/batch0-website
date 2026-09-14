/** Durable automatic Discord replies. Import only in server routes/actions.
 * All mutations run through service-role-only, serialized database transitions.
 * Failed RPCs throw: a database failure must never authorize a model call/send.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type DiscordAutoConfigPatch = {
  enabled?: boolean;
  excludedChannelIds?: string[];
  dailyBudgetMicrousd?: number;
  lifetimeBudgetMicrousd?: number;
  maxRepliesPerDay?: number;
  userCooldownSeconds?: number;
  channelCooldownSeconds?: number;
};

export type DiscordAutoState = Required<DiscordAutoConfigPatch> & {
  masterEnabled: boolean;
  effectiveEnabled: boolean;
  activationAt: string | null;
  activationSnowflake: string | null;
  budgetDay: string;
  dailySpentMicrousd: number;
  dailyReservedMicrousd: number;
  dailyCalls: number;
  lifetimeSpentMicrousd: number;
  lifetimeReservedMicrousd: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastError: string | null;
  lastRunSummary: Record<string, number | string | boolean>;
  backoffUntil: string | null;
  leaseExpiresAt: string | null;
};

export type DiscordAutoLease = { leaseId: string; fence: number; expiresAt: string };
export type DiscordAutoCursor = { channelId: string; lastMessageId: string; lastPolledAt: string };
export type DiscordAutoJobStatus = "generating" | "generated" | "sending" | "sent" | "skipped" | "uncertain";
// Ledger rows use native database column names; no raw source text is persisted.
export type DiscordAutoJob = {
  message_id: string;
  channel_id: string;
  user_id: string;
  source_hash: string;
  source_created_at: string;
  budget_day: string;
  status: DiscordAutoJobStatus;
  reason: string | null;
  generation_fence: number;
  reservation_microusd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  actual_microusd: number | null;
  settled_at: string | null;
  answer: string | null;
  answer_expires_at: string | null;
  send_started_at: string | null;
  send_fence: number | null;
  reply_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscordAutoClaimResult = {
  outcome: "claimed" | "duplicate" | "disabled" | "excluded" | "before_activation" | "future_message" | "budget" | "daily_limit" | "cooldown";
  job: DiscordAutoJob;
};
export type DiscordAutoSendResult =
  | { outcome: "sending"; job: DiscordAutoJob }
  | { outcome: "not_generated" | "disabled" | "ineligible" | "expired" };

export class DiscordAutoStoreError extends Error {
  readonly operation: string;
  readonly code: string;
  constructor(operation: string, code: string) {
    // No provider/source payloads or long SQL errors in runtime logs.
    super(`Discord auto state failed: ${operation} (${code})`);
    this.name = "DiscordAutoStoreError";
    this.operation = operation;
    this.code = code;
  }
}

export function createDiscordAutoStore(admin: Pick<SupabaseClient, "rpc">) {
  async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new DiscordAutoStoreError(name, error.code || "database_error");
    // Null is valid only for a busy run lease. Other null results fail closed.
    if (data === null && args?.p_action !== "acquire_run") {
      throw new DiscordAutoStoreError(name, "empty_response");
    }
    return data as T;
  }
  function transition<T>(action: string, input: Record<string, unknown> = {}) {
    return rpc<T>("discord_auto_transition", { p_action: action, p_input: input });
  }
  function leased(lease: DiscordAutoLease) {
    return { leaseId: lease.leaseId, fence: lease.fence };
  }
  return {
    getState: () => rpc<DiscordAutoState>("discord_auto_state"),
    configure: (patch: DiscordAutoConfigPatch) => transition<DiscordAutoState>("configure", patch),
    acquireRun: () => transition<DiscordAutoLease | null>("acquire_run"),
    releaseRun: (lease: DiscordAutoLease, result: { error?: string; summary?: Record<string, number | string | boolean>; retryAfterMs?: number } = {}) =>
      transition<{ released: true }>("release_run", { ...leased(lease), ...result }),
    getCursors: (lease: DiscordAutoLease) => transition<DiscordAutoCursor[]>("get_cursors", leased(lease)),
    /** Call after processing a page; null records an empty poll at activation. */
    advanceCursor: (lease: DiscordAutoLease, channelId: string, messageId: string | null = null) =>
      transition<{ advanced: true }>("advance_cursor", { ...leased(lease), channelId, messageId }),
    claimJob: (lease: DiscordAutoLease, job: { messageId: string; channelId: string; userId: string; sourceHash: string }) =>
      transition<DiscordAutoClaimResult>("claim_job", { ...leased(lease), ...job }),
    completeGeneration: (lease: DiscordAutoLease, messageId: string, result: { answer: string | null; inputTokens: number; outputTokens: number }) =>
      transition<DiscordAutoJob>("complete_generation", { ...leased(lease), messageId, ...result }),
    beginSend: (lease: DiscordAutoLease, messageId: string) =>
      transition<DiscordAutoSendResult>("begin_send", { ...leased(lease), messageId }),
    /** Only after a provably rejected POST or local request-budget refusal. */
    rejectSend: (lease: DiscordAutoLease, messageId: string, reason: "rate_limit" | "request_budget") =>
      transition<DiscordAutoJob>("send_rejected", { ...leased(lease), messageId, reason }),
    markSent: (lease: DiscordAutoLease, messageId: string, replyId: string) =>
      transition<DiscordAutoJob>("mark_sent", { ...leased(lease), messageId, replyId }),
    /** Only after Discord proves an existing bot-authored reply references this job. */
    reconcileSent: (lease: DiscordAutoLease, messageId: string, replyId: string) =>
      transition<DiscordAutoJob>("reconcile_sent", { ...leased(lease), messageId, replyId }),
    markUncertain: (lease: DiscordAutoLease, messageId: string, reason: string) =>
      transition<DiscordAutoJob>("mark_uncertain", { ...leased(lease), messageId, reason }),
    skipJob: (lease: DiscordAutoLease, messageId: string, reason: string) =>
      transition<DiscordAutoJob>("skip_job", { ...leased(lease), messageId, reason }),
    listPending: (lease: DiscordAutoLease) => transition<DiscordAutoJob[]>("list_pending", leased(lease)),
  };
}

export type DiscordAutoStore = ReturnType<typeof createDiscordAutoStore>;
