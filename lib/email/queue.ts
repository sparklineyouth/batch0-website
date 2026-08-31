import { createAdminClient } from "@/lib/supabase/admin";
import { getEmailSettings } from "@/lib/email/settings";
import { sendQueuedRow, baseVariables, type QueuedRow } from "@/lib/email/dispatch";
import {
  evaluateCondition,
  parseCondition,
  usersFailingCondition,
  skipReasonFor,
} from "@/lib/email/conditions";
import { isMissingTable, type TemplateRow } from "@/lib/email/store";
import { parseCron, wasDue, CronParseError } from "@/lib/email/cron";
import { resolveAudience, audienceAddresses } from "@/lib/email/audience";
import { isAudienceSegment } from "@/lib/email/catalog";

/**
 * The drainer, run by /api/cron/email-queue.
 *
 * Two passes per tick:
 *
 *   1. Scheduled automations — anything whose cron came due since it last ran
 *      fans out to its audience and lands in the outbox.
 *   2. The outbox itself — everything due is gated, rendered, and sent.
 *
 * Doing the fan-out into the queue rather than sending it inline is what
 * bounds a tick: a Monday-morning automation to 800 people writes 800 rows
 * fast and then drains at `max_sends_per_run` per tick, instead of trying to
 * make 800 SMTP round trips inside one serverless invocation and timing out
 * somewhere in the middle with no record of where.
 */

const MAX_ATTEMPTS = 3;
// Exponential-ish backoff between retries, in minutes.
const RETRY_DELAY_MINUTES = [5, 30];

export type DrainReport = {
  scheduledFired: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
  paused: boolean;
  errors: string[];
};

export async function drainEmailQueue(): Promise<DrainReport> {
  const report: DrainReport = {
    scheduledFired: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    paused: false,
    errors: [],
  };

  const settings = await getEmailSettings();
  if (!settings.configured) {
    report.errors.push("Email tables not found — run migration 0052.");
    return report;
  }

  // Scheduled fan-out runs even when paused would be wrong: paused means "no
  // mail leaves", and queueing a week of Monday digests to release in a burst
  // when someone unpauses is not what the switch is for.
  if (settings.automationsPaused) {
    report.paused = true;
    return report;
  }

  const admin = createAdminClient();

  // ---- Pass 1: scheduled automations -------------------------------------
  try {
    const { data: automations, error } = await admin
      .from("email_automations")
      .select("*, steps:email_automation_steps(*)")
      .eq("trigger_type", "schedule")
      .eq("enabled", true);
    if (error && !isMissingTable(error)) report.errors.push(error.message);

    const now = new Date();
    for (const automation of (automations ?? []) as any[]) {
      try {
        const parsed = parseCron(automation.schedule_cron ?? "");
        const last = automation.last_run_at ? new Date(automation.last_run_at) : null;
        if (!wasDue(parsed, last, now)) continue;

        const queued = await fanOutScheduled(automation, now);
        report.queued += queued;
        report.scheduledFired++;

        await admin
          .from("email_automations")
          .update({ last_run_at: now.toISOString(), last_error: null })
          .eq("id", automation.id);
      } catch (err: any) {
        const message =
          err instanceof CronParseError
            ? `Bad schedule: ${err.message}`
            : (err?.message ?? "Scheduled run failed");
        report.errors.push(`${automation.name}: ${message}`);
        // Stamp last_run_at anyway. A broken automation that never advances
        // its clock re-fails on every tick and fills the error list; the
        // failure is already recorded on the row for the admin to see.
        await admin
          .from("email_automations")
          .update({ last_run_at: now.toISOString(), last_error: message })
          .eq("id", automation.id);
      }
    }
  } catch (err: any) {
    report.errors.push(`Scheduled pass failed: ${err?.message ?? err}`);
  }

  // ---- Pass 2: retries ---------------------------------------------------
  try {
    const { data: retryable } = await admin
      .from("email_outbox")
      .select("id, attempts, updated_at")
      .eq("status", "failed")
      .lt("attempts", MAX_ATTEMPTS)
      .order("updated_at", { ascending: true })
      .limit(100);
    const now = Date.now();
    for (const row of (retryable ?? []) as any[]) {
      const wait = RETRY_DELAY_MINUTES[Math.min(row.attempts - 1, RETRY_DELAY_MINUTES.length - 1)] ?? 30;
      if (now - new Date(row.updated_at).getTime() < wait * 60_000) continue;
      await admin
        .from("email_outbox")
        .update({ status: "pending", send_after: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "failed");
      report.retried++;
    }
  } catch {
    /* retries are best-effort */
  }

  // ---- Pass 3: send what's due -------------------------------------------
  try {
    const limit = settings.maxSendsPerRun;
    const { data: due, error } = await admin
      .from("email_outbox")
      .select("id")
      .eq("status", "pending")
      .lte("send_after", new Date().toISOString())
      .order("send_after", { ascending: true })
      .limit(limit);
    if (error) {
      if (!isMissingTable(error)) report.errors.push(error.message);
      return report;
    }

    const ids = (due ?? []).map((r: any) => r.id);
    if (ids.length === 0) return report;

    // Claim before sending. The `.eq("status","pending")` in the update is
    // the lock: two overlapping cron invocations both select the same ids,
    // but only one update matches, so only one of them gets rows back.
    const { data: claimed } = await admin
      .from("email_outbox")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "pending")
      .select(
        "id, template_id, to_email, to_name, user_id, variables, subject_override, html_override, automation_id, step_id, attempts, created_at",
      );

    const rows = (claimed ?? []) as any[];
    if (rows.length === 0) return report;

    // Gate everything up front, in a handful of queries rather than a
    // handful per row. See gateRows for why that matters at 200/run.
    const verdicts = await gateRows(rows);

    const skipped = rows.filter((r) => !verdicts.get(r.id)!.send);
    const sendable = rows.filter((r) => verdicts.get(r.id)!.send);

    if (skipped.length > 0) {
      // One UPDATE per distinct reason instead of one per row.
      const byReason = new Map<string, string[]>();
      for (const r of skipped) {
        const reason = (verdicts.get(r.id) as { reason: string }).reason;
        (byReason.get(reason) ?? byReason.set(reason, []).get(reason)!).push(r.id);
      }
      for (const [reason, skipIds] of byReason) {
        await admin
          .from("email_outbox")
          .update({
            status: "skipped",
            last_error: reason,
            updated_at: new Date().toISOString(),
          })
          .in("id", skipIds);
        report.skipped += skipIds.length;
      }
    }

    if (sendable.length === 0) return report;

    // Bump attempts for the whole batch in one write rather than per row.
    await Promise.all(
      groupBy(sendable, (r) => String(r.attempts ?? 0)).map(([attempts, group]) =>
        admin
          .from("email_outbox")
          .update({ attempts: Number(attempts) + 1 })
          .in(
            "id",
            group.map((r) => r.id),
          ),
      ),
    );

    // Bounded concurrency, not a sequential loop. Strictly sequential sends
    // at ~200-500ms each blow the 60s function budget somewhere past the
    // ~150th email, which would strand rows in `sending` with nothing left
    // running to finish them. Unbounded would trip provider rate limits
    // instead — Gmail especially. Eight in flight clears 200 sends in a few
    // seconds and stays polite.
    const templateCache = new Map<string, TemplateRow | null>();
    const queue = [...sendable];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        const ok = await sendQueuedRow(row as QueuedRow, templateCache);
        if (ok) report.sent++;
        else report.failed++;
      }
    });
    await Promise.all(workers);
  } catch (err: any) {
    report.errors.push(`Send pass failed: ${err?.message ?? err}`);
  }

  return report;
}

/** Group rows by a derived key, preserving insertion order. */
function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = map.get(k);
    if (bucket) bucket.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()];
}

/**
 * Decide send/skip for every claimed row, in a bounded number of queries.
 *
 * The per-row version cost two queries each — one for the step, one for the
 * condition — so a full 200-row drain spent ~400 round trips deciding what to
 * send before sending anything. This loads the distinct steps in one query and
 * asks each distinct condition once across all the users it applies to.
 */
async function gateRows(
  rows: any[],
): Promise<Map<string, { send: true } | { send: false; reason: string }>> {
  const out = new Map<string, { send: true } | { send: false; reason: string }>();
  for (const r of rows) out.set(r.id, { send: true });

  const stepIds = [...new Set(rows.map((r) => r.step_id).filter(Boolean))];
  if (stepIds.length === 0) return out;

  const admin = createAdminClient();
  const { data: steps } = await admin
    .from("email_automation_steps")
    .select("id, condition, enabled")
    .in("id", stepIds);
  const stepById = new Map((steps ?? []).map((s: any) => [s.id, s]));

  // A step disabled while its mail was in flight should not go out — that's
  // what an admin means when they untick it mid-drip.
  const gated: any[] = [];
  for (const r of rows) {
    if (!r.step_id) continue;
    const step = stepById.get(r.step_id);
    if (!step) continue; // step replaced by a save; treat as ungated
    if (!step.enabled) {
      out.set(r.id, { send: false, reason: "Step was disabled before it sent" });
      continue;
    }
    gated.push({ row: r, kind: parseCondition(step.condition) });
  }

  for (const [kind, group] of groupBy(gated, (g) => g.kind)) {
    if (kind === "always") continue;
    if (kind === "no_login_since") {
      // No batch form — it reads auth.users per user.
      for (const g of group) {
        const verdict = await evaluateCondition(
          { kind },
          { userId: g.row.user_id ?? null, queuedAt: g.row.created_at ?? null },
        );
        if (!verdict.send) out.set(g.row.id, verdict);
      }
      continue;
    }
    const userIds = [...new Set(group.map((g) => g.row.user_id).filter(Boolean))];
    const failing = await usersFailingCondition(kind as any, userIds);
    if (failing.size === 0) continue;
    const reason = skipReasonFor(kind as any);
    for (const g of group) {
      if (g.row.user_id && failing.has(g.row.user_id)) {
        out.set(g.row.id, { send: false, reason });
      }
    }
  }
  return out;
}

/**
 * Queue one scheduled automation's steps for its whole audience.
 *
 * The dedupe key pins each send to the run's UTC minute, so two ticks racing
 * on the same due minute (a retried cron invocation, an overlapping manual
 * run) produce one email per person, not two.
 */
export async function fanOutScheduled(
  automation: any,
  now: Date,
): Promise<number> {
  const audience = automation.audience ?? {};
  const segment = isAudienceSegment(audience.segment) ? audience.segment : "students";
  const members = await resolveAudience({
    segment,
    cohortId: audience.cohortId ?? null,
    includeParents: Boolean(audience.includeParents),
  });
  const addresses = audienceAddresses(members, Boolean(audience.includeParents));
  const runStamp = Math.floor(now.getTime() / 60_000);

  const steps = [...(automation.steps ?? [])]
    .filter((s: any) => s.enabled)
    .sort((a: any, b: any) => a.step_index - b.step_index);

  // One chunked INSERT, not one per person-step. The doc comment above used
  // to claim a Monday automation to 800 people "writes 800 rows fast"; it
  // wrote them one round trip at a time — 800 people x 3 steps = 2400
  // sequential inserts, inside the same invocation that then has to send.
  //
  // `ignoreDuplicates` is the dedupe index doing natively what the per-row
  // path did by catching 23505, so a re-run of the same due minute still
  // collapses to one email per person.
  const rows = addresses.flatMap((person) =>
    steps.map((step: any) => ({
      automation_id: automation.id,
      step_id: step.id,
      template_id: step.template_id,
      to_email: person.email,
      to_name: person.name,
      user_id: person.userId,
      variables: baseVariables({ email: person.email, name: person.name }),
      send_after: new Date(
        now.getTime() + step.delay_minutes * 60_000,
      ).toISOString(),
      dedupe_key: `sched:${automation.id}:${step.id}:${person.email.toLowerCase()}:${runStamp}`,
      status: "pending",
    })),
  );

  const admin = createAdminClient();
  let queued = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { data, error } = await admin
      .from("email_outbox")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "dedupe_key",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) {
      console.error("[email/queue] fan-out insert failed", error.message);
      continue;
    }
    queued += data?.length ?? 0;
  }
  return queued;
}
