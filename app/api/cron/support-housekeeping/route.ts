import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAuditMany } from "@/lib/audit";
import { env } from "@/lib/env";
import { isMissingTable } from "@/lib/email/store";
import {
  announceOverdueDigest,
  announceResolved,
  appendReply,
  listOverdueTickets,
  listTicketsForHousekeeping,
  transitionTickets,
  type SupportTicket,
} from "@/lib/support";
import {
  AUTO_CLOSE_AFTER_DAYS,
  AUTO_RESOLVE_AFTER_DAYS,
  AUTO_RESOLVE_NOTE,
} from "@/lib/support-access";
import { ATTACHMENT_BUCKET } from "@/lib/support-attachment-rules";
import {
  chunk,
  daysBefore,
  isMissingBucket,
  sweepOrphanedAttachments,
  type OrphanSweepReport,
} from "@/lib/support-housekeeping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Auto-resolve sends an email per ticket and the sweep walks the bucket, both
// one network round trip after another; the default 10s would cut either off
// partway. 300, like the other daily crons (card-expiring, stripe-reconcile).
export const maxDuration = 300;

/**
 * The support queue's daily chores.
 *
 * Once a day at 13:00 UTC (vercel.json) — 09:00 in New York in summer, 08:00
 * in winter, because Vercel's cron clock is UTC and keeps no daylight time.
 * Before the team's day starts either way, so the overdue digest is waiting
 * when they sit down. Four steps, in this order:
 *
 *  1. Auto-close. Resolved AUTO_CLOSE_AFTER_DAYS (14) days ago and nobody
 *     reopened it: closed, silently. The requester heard when it was resolved;
 *     closing only means the thread stops taking replies (a new request is the
 *     way back), and nobody needs an email to say that.
 *  2. Auto-resolve. Waiting on the requester for AUTO_RESOLVE_AFTER_DAYS (7)
 *     days: resolved with outcome `no_response`, a system note on the thread
 *     saying why (AUTO_RESOLVE_NOTE), and the resolved email and bell. Cheap to
 *     be wrong about — the requester's next reply reopens it (appendReply).
 *  3. Overdue digest. One email to the team inbox listing every ticket past
 *     its reply target. Nothing at all on a day with none.
 *  4. Orphaned uploads. Files that went into the private bucket for a message
 *     that was never sent, deleted once they're a day old. The rules, and why
 *     each one is shaped the way it is, are in lib/support-housekeeping.ts.
 *
 * Every step stands alone. One that throws is logged and noted, and the next
 * still runs: a digest that can't send is no reason to leave stale tickets
 * open or the bucket unswept. A step that finds migration 0090 not applied
 * (the tables, by isMissingTable; the bucket, by isMissingBucket) is a note in
 * a 200, not an incident — a deploy that landed before its SQL, as
 * webinar-followups says of 0084. Anything else answers 500 with `ok: false`,
 * so the cron log shows it; so does the sweep's mass-deletion guard.
 *
 * Idempotent where it matters. Every status change is transitionTickets'
 * conditional update (`.eq("status", from)`), which returns only the rows THIS
 * call moved: two overlapping runs, or a run racing a requester's reply or a
 * teammate's click, act on each ticket once, and only what this run moved is
 * announced and audited. Audit rows are the system's (null actor), as for
 * every cron here.
 */

/** Who the audit rows say did it. */
const BY = "cron/support-housekeeping";

/**
 * Auto-close: the data layer's default batch. It's silent and set-based — an
 * update per hundred ids, no email, no bell — so two hundred costs a few round
 * trips, and a day that somehow has more finishes tomorrow.
 */
const AUTO_CLOSE_PER_RUN = 200;

/**
 * Ids per transitionTickets call. Its `.in("id", …)` filter travels in the
 * request URL; a hundred uuids is about 4 KB, comfortably inside what any
 * proxy in front of PostgREST accepts, where the read's maximum of five
 * hundred would not be.
 */
const IDS_PER_UPDATE = 100;

/**
 * Auto-resolve: at most this many tickets a run, claimed a slice at a time,
 * and no slice claimed once CLAIM_BUDGET_MS of the run has gone.
 *
 * The claim (transitionTickets) commits `resolved` BEFORE the note and the
 * email go out, and a resolved ticket is never selected again. So a ticket
 * claimed by a run that then dies — killed at maxDuration with sends still
 * queued behind it — stays resolved and is never announced: the requester
 * isn't told, and the thread has no note saying why. Claiming a small slice,
 * and only while there is plainly time to announce it, bounds that to one
 * slice. Whatever isn't claimed is still waiting, and tomorrow's run takes it.
 *
 * Each ticket is a note, an email and a bell — a second or so with healthy
 * upstreams — sent one after another, and nothing on the send path paces
 * itself against the email provider's rate limit. Fifty is far more than an
 * ordinary day produces; a backlog (the first run after launch, say) drains
 * over a few days instead of in one burst.
 */
const AUTO_RESOLVE_PER_RUN = 50;
const AUTO_RESOLVE_SLICE = 10;
const CLAIM_BUDGET_MS = 150_000;

/**
 * Nothing new starts after this much of the run — no slice, no folder, no
 * delete. The minute left before maxDuration is for work already in flight.
 */
const SOFT_DEADLINE_MS = 240_000;

/**
 * Per storage listing and per attachments-table read; neither has a timeout
 * of its own, and a hung one would otherwise spend the rest of the run. A read
 * that times out is an error, and an error never licenses a delete.
 */
const CALL_TIMEOUT_MS = 15_000;

type Summary = {
  ok: boolean;
  closed: number;
  resolved: number;
  digest: { sent: boolean; count: number };
  orphans: Omit<OrphanSweepReport, "notes">;
  notes: string[];
};

export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured, like every other cron here.
  // Open, this endpoint would email requesters and delete files on demand.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const summary: Summary = {
    ok: true,
    closed: 0,
    resolved: 0,
    digest: { sent: false, count: 0 },
    orphans: {
      examined: 0,
      removed: 0,
      skipped: 0,
      folders: { examined: 0, total: 0 },
      errors: 0,
      halted: false,
    },
    notes: [],
  };

  // Close before resolving, so a ticket this run resolves can't be closed by
  // it too. (It couldn't be anyway — its resolved_at is now — but the order
  // says so without the arithmetic.)
  await step(summary, "auto-close", () => autoClose(summary, startedAt));
  await step(summary, "auto-resolve", () => autoResolve(summary, startedAt));
  await step(summary, "overdue digest", () => overdueDigest(summary));
  await step(summary, "orphaned attachments", () => sweepOrphans(summary, startedAt));

  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}

/**
 * Runs one step so that nothing it throws reaches the next. Whatever the step
 * already wrote to `summary` stands: a slice resolved before a later slice
 * failed was still resolved, and the response says so.
 */
async function step(summary: Summary, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[cron/support-housekeeping] ${name} failed`, error.message);
    if (isMissingTable(error) || isMissingBucket(error)) {
      summary.notes.push(`${name}: skipped — migration 0090 isn't applied here yet (${error.message})`);
      return;
    }
    summary.ok = false;
    summary.notes.push(`${name} failed: ${error.message}`);
  }
}

async function autoClose(summary: Summary, now: number): Promise<void> {
  const stale = await listTicketsForHousekeeping({
    status: "resolved",
    column: "resolved_at",
    before: daysBefore(now, AUTO_CLOSE_AFTER_DAYS),
    limit: AUTO_CLOSE_PER_RUN,
  });
  for (const ids of chunk(stale.map((t) => t.id), IDS_PER_UPDATE)) {
    const closed = await transitionTickets({ ids, from: "resolved", to: "closed" });
    summary.closed += closed.length;
    await logAuditMany(null, auditRows("support_ticket.auto_closed", closed));
  }
}

async function autoResolve(summary: Summary, startedAt: number): Promise<void> {
  const quiet = await listTicketsForHousekeeping({
    status: "waiting_on_requester",
    column: "status_changed_at",
    before: daysBefore(startedAt, AUTO_RESOLVE_AFTER_DAYS),
    limit: AUTO_RESOLVE_PER_RUN,
  });
  const slices = chunk(quiet.map((t) => t.id), AUTO_RESOLVE_SLICE);
  for (let i = 0; i < slices.length; i++) {
    if (Date.now() - startedAt >= CLAIM_BUDGET_MS) {
      const left = slices.slice(i).reduce((n, s) => n + s.length, 0);
      summary.notes.push(`auto-resolve: out of time to announce more; ${left} waiting ticket(s) left for tomorrow`);
      return;
    }
    const resolved = await transitionTickets({
      ids: slices[i],
      from: "waiting_on_requester",
      to: "resolved",
      outcome: "no_response",
    });
    summary.resolved += resolved.length;
    // Audit before announcing: the transition is the fact, and it has
    // happened whether or not the email after it gets out.
    await logAuditMany(null, auditRows("support_ticket.auto_resolved", resolved));
    for (const ticket of resolved) await announceAutoResolved(ticket, summary);
  }
}

/**
 * The note, then the announcement, so the thread the email links to already
 * says why. Never throws: every ticket in a claimed slice is already resolved,
 * so one ticket's failure must not cost the rest of the slice theirs.
 */
async function announceAutoResolved(ticket: SupportTicket, summary: Summary): Promise<void> {
  try {
    // A system message moves no status (appendReply); `ticket` is the row
    // transitionTickets returned, already resolved.
    await appendReply({ ticket, body: AUTO_RESOLVE_NOTE, author: { kind: "system" } });
  } catch (err) {
    console.error("[cron/support-housekeeping] auto-resolve note failed", ticket.reference, err);
    summary.notes.push(`auto-resolve: the note on ${ticket.reference} didn't post (see logs)`);
  }
  try {
    // Best-effort and self-logging. The fresh row matters: the bell's dedupe
    // key is this resolution's resolved_at.
    await announceResolved(ticket, { auto: true });
  } catch (err) {
    console.error("[cron/support-housekeeping] auto-resolve announcement failed", ticket.reference, err);
    summary.notes.push(`auto-resolve: couldn't announce ${ticket.reference} (see logs)`);
  }
}

async function overdueDigest(summary: Summary): Promise<void> {
  const at = Date.now();
  summary.digest = await announceOverdueDigest(await listOverdueTickets(at), at);
  if (summary.digest.count > 0 && !summary.digest.sent) {
    summary.notes.push(
      `overdue digest: ${summary.digest.count} overdue, but the email didn't go out (no team inbox, or the send failed — see logs)`,
    );
  }
}

async function sweepOrphans(summary: Summary, startedAt: number): Promise<void> {
  const admin = createAdminClient();
  const bucket = admin.storage.from(ATTACHMENT_BUCKET);
  const { notes, ...counts } = await sweepOrphanedAttachments({
    storage: {
      list: (prefix, page) =>
        bucket.list(
          prefix,
          // Name order, said out loud: paging by offset is only stable over
          // a stable order.
          { limit: page.limit, offset: page.offset, sortBy: { column: "name", order: "asc" } },
          { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
        ),
      remove: (paths) => bucket.remove(paths),
    },
    findRecorded: async (paths) => {
      const { data, error } = await admin
        .from("support_ticket_attachments")
        .select("storage_path")
        .in("storage_path", paths)
        .abortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS));
      if (error) return { data: null, error };
      // An answer with no list in it stays one: the sweep reads that as a
      // failed read, never as "none of these is recorded".
      return {
        data: Array.isArray(data)
          ? data.map((r: { storage_path: string }) => r.storage_path)
          : null,
        error: null,
      };
    },
    now: Date.now(),
    deadline: startedAt + SOFT_DEADLINE_MS,
  });
  summary.orphans = counts;
  for (const note of notes) summary.notes.push(`orphaned attachments: ${note}`);
  if (counts.halted) summary.ok = false;
  if (counts.halted || counts.errors > 0) {
    console.error("[cron/support-housekeeping] orphan sweep:", notes.join(" | "));
  }
}

function auditRows(action: string, tickets: SupportTicket[]) {
  return tickets.map((t) => ({
    action,
    targetType: "support_ticket",
    targetId: t.id,
    payload: { reference: t.reference, by: BY },
  }));
}
