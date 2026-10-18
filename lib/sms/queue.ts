import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";
import { canSend, revokeConsent } from "@/lib/sms/consent";
import { nextAllowedSend } from "@/lib/sms/quiet-hours";
import { providerFor } from "@/lib/sms/providers";
import { isUnsubscribedCode } from "@/lib/sms/providers/twilio";
import { isFirstMessageTo, withDisclosure } from "@/lib/sms/send";
import { countSegments } from "@/lib/sms/segments";

/**
 * The SMS drainer, run by /api/cron/sms-queue.
 *
 * Deliberately a near-copy of lib/email/queue.ts, down to the claim protocol and
 * the retry ladder, so the two can be read side by side and a fix to one is an
 * obvious fix to the other. The differences are all consequences of SMS costing
 * money per message and carrying legal weight:
 *
 *   * CONSENT IS RE-CHECKED AT DRAIN TIME, per row. Email gates on step
 *     conditions; this gates on whether the person still wants the message. A
 *     STOP that arrives after a campaign is queued has to stop the campaign, and
 *     the only place that can happen is here.
 *
 *   * QUIET HOURS ARE RE-EVALUATED, because a row can be due and still impolite:
 *     a campaign queued at 3pm Eastern for a Pacific number was inside the window
 *     when it was written and outside it by the time it drained. Such a row is
 *     PUSHED FORWARD, not failed.
 *
 *   * THE SEND IS SEQUENTIAL. Email batches 100 per HTTP request through Resend;
 *     a toll-free number is provisioned around 3 messages/second and a burst
 *     earns carrier filtering, which is invisible until a whole campaign silently
 *     stops being delivered.
 *
 * There is no scheduled-automation pass. SMS campaigns are composed and queued
 * by an admin at /admin/sms/blast and nothing else produces a row; event-
 * triggered texts would reuse the email event bus and are a separate piece of
 * work (docs/sms.md, "Not built yet").
 */

/**
 * Exported because the webhook needs the SAME ceiling: a row failed by a
 * carrier receipt has never been through finish(), so it must be pushed to the
 * cap there or the retry pass treats a permanent failure as a fresh row.
 */
export const MAX_ATTEMPTS = 3;
// Exponential-ish backoff between retries, in minutes. Same ladder as email.
const RETRY_DELAY_MINUTES = [5, 30];
// How long a row may sit claimed as `sending` before the drain treats the
// invocation that claimed it as gone. Past both the function ceiling and the
// cron interval, so reclaiming can never take a row out from under a live send.
const STRANDED_CLAIM_MINUTES = 10;

/**
 * Pause between provider calls.
 *
 * ~3/second is what a verified toll-free number is provisioned for, and exceeding
 * it earns carrier filtering that is invisible until a whole campaign stops being
 * delivered. 350ms keeps us just under.
 */
const SEND_SPACING_MS = 350;

/**
 * Hard ceiling per invocation, independent of the settings value.
 *
 * `max_sends_per_run` is an admin-facing throttle and can be set as high as 2000.
 * The real bound is arithmetic: the route allows 60s, each row costs 350ms of
 * deliberate spacing plus roughly 300–400ms of provider and database I/O, so
 * about 60 rows is what honestly fits. This was 120, which could not finish —
 * 120 × 350ms is 42s of pure sleeping before any real work, so the tail of every
 * full batch was killed mid-flight and left claimed as `sending`.
 *
 * The wall-clock check in the send loop is the real safety net (it releases the
 * claims it did not get to). This ceiling just keeps the common case from ever
 * reaching it. At the program's actual volume a single tick clears the queue.
 */
const MAX_PER_DRAIN = 60;

export type SmsDrainReport = {
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  retried: number;
  segments: number;
  paused: boolean;
  /**
   * Why the drain did nothing at all, when it is because texting isn't set up
   * — the migration hasn't run, or there are no provider credentials yet.
   *
   * Not an error. It is the state the feature ships in and may sit in for
   * weeks while a toll-free number is verified, and the cron runs every five
   * minutes: reporting it in `errors` would put 288 identical lines a day into
   * the logs and train whoever reads them to skim past the drain.
   */
  inert: string | null;
  errors: string[];
};

export async function drainSmsQueue(): Promise<SmsDrainReport> {
  const report: SmsDrainReport = {
    sent: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    retried: 0,
    segments: 0,
    paused: false,
    inert: null,
    errors: [],
  };

  const settings = await getSmsSettings();
  if (!settings.configured) {
    report.inert = "Texting isn't set up yet: migration 0106 hasn't run.";
    return report;
  }
  // Fail closed. The row carries the quiet-hours window; draining on defaults
  // could send at 6am local to someone whose zone we then mis-evaluate.
  if (settings.readError) {
    report.errors.push(`SMS settings unavailable: ${settings.readError}`);
    return report;
  }
  if (settings.smsPaused) {
    report.paused = true;
    return report;
  }
  // Before any row is read: with no credentials nothing can send, so nothing
  // is claimed, retried or reclaimed either. (sendSms refuses to park rows in
  // this state, so there should be none to find.)
  if (!hasCredentials(settings)) {
    report.inert = "No provider credentials yet — add them at /admin/sms/settings.";
    return report;
  }

  const admin = createAdminClient();
  const provider = providerFor(settings);
  const statusCallback = env.siteUrl.startsWith("https://")
    ? `${env.siteUrl}/api/webhooks/sms`
    : undefined;

  // ---- Pass 1: reclaim + retries -----------------------------------------
  try {
    // Rows stranded in `sending`. A claim is only unwound by the process that
    // made it, so an invocation that dies mid-batch leaves rows nothing will
    // touch again. They land in `failed` rather than `pending` because a strand
    // can also mean the text WAS sent and only the result write died — routing
    // through the retry ladder puts that duplicate risk behind an attempt cap
    // and a delay, and leaves a reason the outbox shows. The trade is the same
    // one email makes and documented at lib/email/queue.ts:151.
    const { data: reclaimed } = await admin
      .from("sms_outbox")
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
      console.error(`[sms/queue] reclaimed ${reclaimed.length} row(s) stranded in sending`);
    }

    const { data: retryable } = await admin
      .from("sms_outbox")
      .select("id, attempts, updated_at")
      .eq("status", "failed")
      .lt("attempts", MAX_ATTEMPTS)
      .order("updated_at", { ascending: true })
      .limit(100);
    const now = Date.now();
    for (const row of (retryable ?? []) as any[]) {
      // Clamped at both ends. `attempts - 1` is -1 for a row that reached
      // `failed` without ever being attempted — a webhook-reported carrier
      // failure, or a reclaim — and a negative index reads as `undefined`, which
      // fell through to the 30-minute tail instead of the intended 5.
      const wait =
        RETRY_DELAY_MINUTES[
          Math.min(Math.max(Number(row.attempts ?? 0) - 1, 0), RETRY_DELAY_MINUTES.length - 1)
        ] ?? 30;
      if (now - new Date(row.updated_at).getTime() < wait * 60_000) continue;
      await admin
        .from("sms_outbox")
        .update({ status: "pending", send_after: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "failed");
      report.retried++;
    }
  } catch {
    /* retries are best-effort */
  }

  // ---- Pass 2: send what's due -------------------------------------------
  try {
    const limit = Math.min(settings.maxSendsPerRun, MAX_PER_DRAIN);
    const { data: due, error } = await admin
      .from("sms_outbox")
      .select("id")
      .eq("status", "pending")
      .lte("send_after", new Date().toISOString())
      .order("send_after", { ascending: true })
      .limit(limit);
    if (error) {
      if (!isMissingSchemaError(error)) report.errors.push(error.message);
      return report;
    }

    const ids = (due ?? []).map((r: any) => r.id);
    if (ids.length === 0) return report;

    // Claim before sending. The `.eq("status","pending")` in the update IS the
    // lock: two overlapping cron invocations both select the same ids, but only
    // one update matches, so only one of them gets rows back.
    const { data: claimed } = await admin
      .from("sms_outbox")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "pending")
      .select(
        "id, to_phone, to_name, user_id, party, purpose, body, segments, template_key, campaign_id, attempts",
      );

    const rows = (claimed ?? []) as any[];
    if (rows.length === 0) return report;

    // Bump `attempts` on the whole claimed batch, immediately after the claim.
    //
    // This used to happen only on the drain's own failure path inside finish(),
    // which left every OTHER producer of a `failed` row — the stranded-claim
    // reclaim above, a carrier receipt arriving at the webhook — writing `failed`
    // with the attempt counter untouched. The retry pass only tests
    // `attempts < MAX_ATTEMPTS`, so those rows were retried without bound: the
    // ladder existed but nothing was climbing it. Counting an attempt when the
    // attempt is *made* is both correct and the thing every other path can rely
    // on. One UPDATE per distinct prior value, the way lib/email/queue.ts does it.
    const byAttempts = new Map<number, string[]>();
    for (const row of rows) {
      const n = Number(row.attempts ?? 0);
      const list = byAttempts.get(n) ?? [];
      list.push(row.id);
      byAttempts.set(n, list);
      row.attempts = n + 1;
    }
    for (const [prior, batchIds] of byAttempts) {
      await admin
        .from("sms_outbox")
        .update({ attempts: prior + 1 })
        .in("id", batchIds);
    }

    // Wall-clock budget.
    //
    // The route allows 60s and the drain deliberately sleeps SEND_SPACING_MS
    // between provider calls, so a full batch can cost more time than it is
    // given — and a drain killed mid-batch leaves the remainder claimed as
    // `sending`, which is exactly the strand the reclaim pass exists to clean up
    // ten minutes later. Stopping early and RELEASING the untouched claims turns
    // an overrun into a no-op instead of a ten-minute delay for those rows.
    const startedAt = Date.now();
    const BUDGET_MS = 45_000;
    const unreleased: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (Date.now() - startedAt > BUDGET_MS) {
        // Everything from here on was claimed but never attempted. Hand the
        // claims back so the next tick picks them up in five minutes rather than
        // the reclaim pass rescuing them in ten — and undo the attempt we counted
        // for them above, since no attempt was made.
        unreleased.push(...rows.slice(i).map((r: any) => r.id));
        break;
      }

      const now = new Date();

      // Quiet hours, re-evaluated. A row queued while the window was open can
      // come due after it closed — push it forward rather than failing it.
      const allowedAt = nextAllowedSend(row.to_phone, settings.quietHours, now);
      if (!allowedAt) {
        // Deferred a day, not dropped. An unsatisfiable window is a misconfigured
        // setting (or an area code we can't place), and both get fixed by a human
        // — so the message has to still be there when they do. Skipping it would
        // silently discard real mail over a settings mistake.
        await admin
          .from("sms_outbox")
          .update({
            status: "pending",
            send_after: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
            last_error:
              "Quiet-hours window can't be satisfied for this number — held 24h. Check /admin/sms/settings.",
            updated_at: now.toISOString(),
          })
          .eq("id", row.id);
        report.deferred++;
        continue;
      }
      if (allowedAt.getTime() > now.getTime()) {
        await admin
          .from("sms_outbox")
          .update({
            status: "pending",
            send_after: allowedAt.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", row.id);
        report.deferred++;
        continue;
      }

      // Consent, re-checked per row at send time. This is the whole reason the
      // drain doesn't just trust the enqueue-time decision.
      const verdict = await canSend(row.to_phone, row.purpose);
      if (!verdict.allowed) {
        await finish(row.id, { status: "skipped", error: verdict.reason });
        report.skipped++;
        continue;
      }

      // The CTIA first-message disclosure, applied HERE and not only on the
      // inline path in lib/sms/send.ts. Campaigns always queue, and quiet hours
      // route transactional messages through the queue too, so the inline path is
      // the exception — a disclosure applied only there would be missing from
      // very nearly every message we actually send, which is the opposite of
      // what the rule requires. The sent body is re-measured so the reported
      // segment count is what we were billed for, not what was queued.
      const first = await isFirstMessageTo(row.to_phone);
      const body = withDisclosure(row.body, settings, first);
      const segments = body === row.body ? (row.segments ?? 1) : countSegments(body);

      const result = await provider.send(
        { to: row.to_phone, from: settings.fromNumber!, body, statusCallback },
        settings,
      );

      if (result.ok) {
        await finish(row.id, {
          status: "sent",
          providerId: result.providerId,
          segments: segments === row.segments ? undefined : segments,
        });
        report.sent++;
        report.segments += segments;
      } else {
        if (isUnsubscribedCode(result.errorCode)) {
          // Our consent records and the carrier's have diverged. Write the
          // suppression locally so the retry ladder stops hammering a number
          // that will never be delivered to.
          const suppressed = await revokeConsent({
            phone: row.to_phone,
            source: "provider_21610",
            inboundBody: "Provider reported the number as unsubscribed.",
          });
          await finish(row.id, {
            status: "skipped",
            error: suppressed.ok
              ? "Provider reports this number as unsubscribed; suppressed locally."
              : // Do not claim a suppression that did not land. Every later
                // campaign would re-send to a number the carrier is blocking,
                // and the outbox would say we had handled it.
                `Provider reports this number as unsubscribed, but the suppression could NOT be recorded: ${suppressed.error}`,
          });
          if (!suppressed.ok) {
            report.errors.push(
              `Could not suppress ${row.to_phone} after a carrier opt-out: ${suppressed.error}`,
            );
          }
          report.skipped++;
        } else if (!result.retryable) {
          // Terminal: jump the attempt counter to the cap so the retry pass
          // doesn't pick it up. Failing without this would retry a landline
          // three times and bill for all three.
          await finish(row.id, {
            status: "failed",
            error: result.reason,
            attempts: MAX_ATTEMPTS,
          });
          report.failed++;
        } else {
          await finish(row.id, { status: "failed", error: result.reason });
          report.failed++;
        }
      }

      // Spacing between provider calls. Skipped rows didn't touch the provider,
      // so they don't pay it — only a real send does.
      if (result.ok || result.retryable) {
        await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
      }
    }

    // Hand back any claim the wall-clock budget cut short, and un-count the
    // attempt that was pre-recorded for it. Without the release these rows would
    // sit in `sending` until the ten-minute reclaim pass demoted them to
    // `failed`; with it, the next tick simply picks them up.
    if (unreleased.length > 0) {
      await admin
        .from("sms_outbox")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .in("id", unreleased)
        .eq("status", "sending");
      for (const [prior, batchIds] of byAttempts) {
        const rollback = batchIds.filter((id) => unreleased.includes(id));
        if (rollback.length > 0) {
          await admin.from("sms_outbox").update({ attempts: prior }).in("id", rollback);
        }
      }
      report.errors.push(
        `Ran out of time with ${unreleased.length} claimed row(s) unsent — released for the next tick.`,
      );
    }

    await rollUpCampaigns(rows);
  } catch (err: any) {
    report.errors.push(`Send pass failed: ${err?.message ?? err}`);
  }

  return report;

  /**
   * Write the terminal state for one row.
   *
   * Does NOT touch `attempts`: the whole claimed batch is incremented right after
   * the claim, so an attempt is counted when it is made rather than when it
   * happens to fail. `args.attempts` remains available for the one case that
   * needs an override — a provider failure the carrier calls terminal, which
   * jumps straight to the cap so the retry pass never picks it up.
   */
  async function finish(
    id: string,
    args: {
      status: "sent" | "failed" | "skipped";
      error?: string;
      providerId?: string;
      attempts?: number;
      /** Set only when the disclosure changed what went on the wire. */
      segments?: number;
    },
  ) {
    const patch: Record<string, unknown> = {
      status: args.status,
      last_error: args.error ?? null,
      updated_at: new Date().toISOString(),
    };
    if (args.status === "sent") {
      patch.sent_at = new Date().toISOString();
      patch.provider_id = args.providerId ?? null;
    }
    if (args.attempts != null) patch.attempts = args.attempts;
    // Store what was actually billed, not what was queued, so the campaign's
    // cost and the outbox agree with the invoice.
    if (args.segments != null) patch.segments = args.segments;

    const { error } = await admin.from("sms_outbox").update(patch).eq("id", id);
    if (error) {
      // The text may well have gone out. Logging loudly is all that's available
      // — the row stays in `sending` and the reclaim pass above will route it
      // through the retry ladder, which is the documented trade.
      console.error(`[sms/queue] could not record result for ${id}`, error.message);
    }
  }

  /**
   * Refresh the denormalized counters on any campaign this drain touched.
   *
   * Recounted from the outbox rather than incremented, so a retried row or a
   * partially-failed drain can never leave the campaign's totals drifting away
   * from the rows they describe.
   */
  async function rollUpCampaigns(rows: any[]) {
    const campaignIds = Array.from(
      new Set(rows.map((r) => r.campaign_id).filter(Boolean)),
    ) as string[];
    for (const id of campaignIds) {
      const { data } = await admin
        .from("sms_outbox")
        .select("status")
        .eq("campaign_id", id)
        .limit(5000);
      const statuses = (data ?? []).map((r: any) => r.status as string);
      const sent = statuses.filter((s) => s === "sent").length;
      const failed = statuses.filter(
        (s) => s === "failed" || s === "skipped" || s === "canceled",
      ).length;
      const outstanding = statuses.filter(
        (s) => s === "pending" || s === "sending",
      ).length;
      await admin
        .from("sms_campaigns")
        .update({
          sent_count: sent,
          failed_count: failed,
          status: outstanding > 0 ? "sending" : "done",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        // Never resurrect a campaign an admin stopped. Recomputing the status
        // unconditionally would move `canceled` back to `done` on the next tick
        // that touched any of its rows, so the Stop button looked like it had
        // failed. The counters above are still worth refreshing, which is why
        // this is a filter on the write rather than an early return.
        .neq("status", "canceled");
    }
  }
}
