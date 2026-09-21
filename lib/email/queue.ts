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
import { parseCron, cronMatches, CronParseError, type ParsedCron } from "@/lib/email/cron";
import { resolveAudience, audienceAddresses } from "@/lib/email/audience";
import { isAudienceSegment } from "@/lib/email/catalog";
import { recoveryContext } from "@/lib/email-recovery";

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
// How long a row may sit claimed as `sending` before the drain treats the
// invocation that claimed it as gone. Comfortably past both the 60s function
// ceiling and the five-minute cron interval, so reclaiming can never take a
// row out from under a live send.
const STRANDED_CLAIM_MINUTES = 10;

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
  // Settings read but unreadable: skip the tick rather than drain on the env
  // defaults, which would send this batch from the wrong transport if the site
  // is on SMTP. The next tick is five minutes out and the rows keep their
  // place in the outbox, so waiting costs nothing.
  if (settings.readError) {
    report.errors.push(`Email settings unavailable: ${settings.readError}`);
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
        const dueMinute = dueMinuteFor(parsed, last, now);
        if (dueMinute === null) continue;

        const queued = await fanOutScheduled(automation, now, dueMinute);
        report.queued += queued;
        report.scheduledFired++;

        // The clock is stamped AFTER the fan-out on purpose. Because the
        // dedupe key names the due minute, a second fan-out of the same
        // occurrence collapses on the dedupe index, so an invocation killed
        // halfway through is healed by the next tick writing only the rows
        // that are missing. Claiming the run first would instead leave that
        // remainder stamped as done and silently unsent — duplicates traded
        // for a whole audience quietly not getting their mail.
        const { error: stampError } = await admin
          .from("email_automations")
          .update({ last_run_at: now.toISOString(), last_error: null })
          .eq("id", automation.id);
        if (stampError) {
          // Worth surfacing: the fan-out itself is idempotent now, but an
          // automation whose clock never advances re-fans-out on every tick
          // for the whole catch-up window.
          report.errors.push(`${automation.name}: run not recorded — ${stampError.message}`);
        }
      } catch (err: any) {
        const message =
          err instanceof CronParseError
            ? `Bad schedule: ${err.message}`
            : (err?.message ?? "Scheduled run failed");
        report.errors.push(`${automation.name}: ${message}`);
        // Stamp last_run_at anyway. A broken automation that never advances
        // its clock re-fails on every tick and fills the error list; the
        // failure is already recorded on the row for the admin to see.
        // Guarded on its own because a throw here escapes this handler and
        // takes every automation after this one down with it.
        try {
          await admin
            .from("email_automations")
            .update({ last_run_at: now.toISOString(), last_error: message })
            .eq("id", automation.id);
        } catch {
          /* the failure itself is already in the report */
        }
      }
    }
  } catch (err: any) {
    report.errors.push(`Scheduled pass failed: ${err?.message ?? err}`);
  }

  // ---- Pass 2: retries ---------------------------------------------------
  try {
    // Reclaim rows stranded in `sending`. A claim is only ever unwound by the
    // process that made it, so an invocation that dies mid-batch — the 60s
    // ceiling, a provider call with no timeout on it — leaves rows nothing
    // will touch again: the due pass below only looks at `pending`, the retry
    // pass at `failed`, and the admin's retry button refuses a `sending` row.
    //
    // They land in `failed` rather than straight back in `pending` because a
    // strand can also mean the mail WAS delivered and only the result write
    // died (dispatch's finish() logs that and moves on). Nothing on the row
    // tells the two apart — status and provider_id are written together — so
    // any reclaim risks a second copy to a real person. Routing through
    // `failed` puts that risk behind the retry ladder below: attempt-bounded
    // by MAX_ATTEMPTS, spaced by RETRY_DELAY_MINUTES, and carrying a reason
    // the outbox shows. The trade is deliberate — a rare, attributable
    // duplicate instead of either a silent instant re-send or mail that never
    // arrives at all.
    //
    // No attempts filter here on purpose: a row at the attempt cap still has
    // to leave `sending` so it shows up as a failure someone can act on.
    const { data: reclaimed } = await admin
      .from("email_outbox")
      .update({
        status: "failed",
        last_error:
          "Stranded mid-send — the drain that claimed this row died before recording a result",
        updated_at: new Date().toISOString(),
      })
      .eq("status", "sending")
      .lt(
        "updated_at",
        new Date(Date.now() - STRANDED_CLAIM_MINUTES * 60_000).toISOString(),
      )
      .select("id");
    if (reclaimed && reclaimed.length > 0) {
      console.error(
        `[email/queue] reclaimed ${reclaimed.length} row(s) stranded in sending`,
      );
    }

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
 * Which due minute does this schedule owe, if any? Null when nothing is due.
 *
 * `wasDue` answers yes/no, but the fan-out needs the occurrence's identity,
 * not just its existence: the dedupe key has to name the minute the cron came
 * due, or a fan-out that runs twice for one occurrence keys the second attempt
 * on a later minute and writes a whole second audience instead of colliding
 * with the first. The window walked here is deliberately the same one `wasDue`
 * walks — same exclusive `after`, same catch-up cap — so the two can't
 * disagree about whether something is owed.
 *
 * Newest-first, returning the most recent match rather than the oldest: a
 * schedule finer than the drain interval can match several minutes in the
 * window, and the oldest of those falls out of the window as `now` advances,
 * which would hand the following tick a different stamp for the same work.
 */
function dueMinuteFor(
  parsed: ParsedCron,
  after: Date | null,
  now: Date,
  maxCatchUpMinutes = 60 * 24,
): number | null {
  const end = Math.floor(now.getTime() / 60000);
  const startFrom = after ? Math.floor(after.getTime() / 60000) + 1 : end;
  const start = Math.max(startFrom, end - maxCatchUpMinutes);
  for (let m = end; m >= start; m--) {
    if (cronMatches(parsed, new Date(m * 60000))) return m;
  }
  return null;
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
    if (!step) {
      out.set(r.id, { send: false, reason: "Automation step was replaced; review before sending" });
      continue;
    }
    if (!step.enabled) {
      out.set(r.id, { send: false, reason: "Step was disabled before it sent" });
      continue;
    }
    gated.push({ row: r, kind: parseCondition(step.condition) });
  }

  for (const [kind, group] of groupBy(gated, (g) => g.kind)) {
    if (kind === "always") continue;
    if (kind === "no_login_since" || kind === "not_paid") {
      // No batch form — it reads auth.users per user.
      for (const g of group) {
        const verdict = await evaluateCondition(
          { kind },
          { userId: g.row.user_id ?? null, queuedAt: g.row.created_at ?? null, ...recoveryContext(g.row.variables) },
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
 * The dedupe key pins each send to the occurrence it belongs to — the UTC
 * minute the cron came due, which the drainer passes as `dueMinute` — not to
 * the minute this fan-out happens to run. That's what makes a second pass over
 * one occurrence free: a retried cron invocation, a manual drain overlapping a
 * tick, or a fan-out killed after 1500 of 2400 rows all collapse onto the same
 * keys and produce one email per person, not two.
 *
 * With no `dueMinute` there is no occurrence to name and the key falls back to
 * the invocation minute, which only dedupes callers landing inside the same
 * UTC minute. That's the "Run now" button's contract, not the cron's.
 */
export async function fanOutScheduled(
  automation: any,
  now: Date,
  dueMinute?: number,
): Promise<number> {
  const audience = automation.audience ?? {};
  const segment = isAudienceSegment(audience.segment) ? audience.segment : "students";
  const members = await resolveAudience({
    segment,
    cohortId: audience.cohortId ?? null,
    includeParents: Boolean(audience.includeParents),
  });
  const addresses = audienceAddresses(members, Boolean(audience.includeParents));
  const windowHours = Math.max(0, Number(automation.dedupe_window_hours) || 0);
  const occurrence = dueMinute ?? Math.floor(now.getTime() / 60_000);
  // A bucket gives concurrent fan-outs a shared unique key. A rolling lookback
  // below also prevents a repeat just across the bucket boundary.
  const runStamp = windowHours > 0 ? `window:${Math.floor(occurrence / (windowHours*60))}` : String(occurrence);

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
  let rows = addresses.flatMap((person) =>
    steps.map((step: any) => ({
      automation_id: automation.id,
      step_id: step.id,
      template_id: step.template_id,
      to_email: person.email,
      to_name: person.name,
      user_id: person.userId,
      variables: { ...baseVariables({ email: person.email, name: person.name }), application_id: person.applicationId ?? "", cohort_id: person.cohortId ?? "", cohort_name: person.cohortName ?? "" },
      send_after: new Date(
        now.getTime() + step.delay_minutes * 60_000,
      ).toISOString(),
      dedupe_key: `sched:${automation.id}:${step.id}:${person.email.toLowerCase()}:${runStamp}`,
      status: "pending",
    })),
  );

  const admin = createAdminClient();
  if(windowHours > 0 && rows.length > 0) {
    const {data:recent,error}=await admin.from("email_outbox").select("step_id,to_email")
      .eq("automation_id",automation.id).neq("status","skipped")
      .gte("created_at",new Date(now.getTime()-windowHours*3600000).toISOString()).limit(10000);
    if(error)throw new Error("Could not check the follow-up repeat window; no mail queued");
    const seen=new Set((recent??[]).map(r=>`${r.step_id}:${r.to_email.toLowerCase()}`));
    rows=rows.filter(r=>!seen.has(`${r.step_id}:${r.to_email.toLowerCase()}`));
  }
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
