import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyApplicationDecision } from "@/lib/application-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each due acceptance sends an email + does a Discord sync over the network.
// The default 10s could cut a batch of them off mid-flight; 60 matches the
// email-queue cron for the same reason.
export const maxDuration = 60;

/** What one invocation may spend, and why these numbers.
 *
 *  A row is a dozen Supabase round trips, a Resend send and up to five Discord
 *  calls: a second or two when every upstream is healthy, and unbounded when
 *  one isn't, because none of those calls carries a timeout of its own. Run
 *  sequentially, the old cap of 100 never fitted in the minute above, and
 *  overrunning here isn't a slow cron — it's the Gateway Timeout this path has
 *  thrown in production, killed mid-row with the consequences described below.
 *  So: at most 25 rows, no row STARTED past the batch budget, and every await
 *  in the loop bounded — the bookkeeping reads and writes around a row have no
 *  timeout of their own either. Worst case for the last row admitted is
 *  25 + 5 + 20 + 5 = 55s, which leaves five seconds inside maxDuration to
 *  answer. */
const DUE_BATCH_LIMIT = 25;
const BATCH_BUDGET_MS = 25_000;
const ROW_BUDGET_MS = 20_000;
/** The attempt-count read and the re-park write: one round trip each. */
const BOOKKEEPING_BUDGET_MS = 5_000;

/**
 * How many times one application may be run through the acceptance before this
 * route stops trying.
 *
 * Retrying is how an acceptance that committed but never announced reaches the
 * student at all (see `repark`). But nothing downstream dedupes an acceptance —
 * not `sendTemplated` (lib/email/send.ts), not the `application_accepted`
 * notify in lib/admissions.ts — so every retry is another acceptance email to a
 * real teenager, and an upstream that fails forever would send one every five
 * minutes forever. Three attempts, then it is a human's problem and says so in
 * the response's `errors`.
 */
const MAX_ACCEPT_ATTEMPTS = 3;

/**
 * Fires application acceptances that were scheduled for a future moment (see
 * migration 0062 and `scheduleAcceptance`).
 *
 * Every five minutes, which is the tolerance: an acceptance scheduled for 6am
 * lands within five minutes of 6am. The match is "due at or before now AND
 * still undecided", so an application a reviewer decided by hand in the
 * meantime — which cleared the scheduled_accept_* columns as part of that
 * decision — is simply not selected here. A parked acceptance therefore fires
 * once, or not at all if it was superseded first (the one thing that can
 * repeat is the announcement, deliberately and at most MAX_ACCEPT_ATTEMPTS
 * times — see below).
 *
 * We run the SAME acceptance the Accept button runs (announceAcceptance email,
 * Discord role sync, audit row), attributed to the reviewer who scheduled it —
 * `applyApplicationDecision` clears the parked columns as part of the write, so
 * a row is never picked up twice by accident, and a one-minute maxDuration
 * against a five-minute schedule means two invocations never overlap either.
 *
 * That same clear is the one thing in here with no undo: it commits
 * `status = 'accepted'` with the schedule erased BEFORE the acceptance email
 * and the Discord sync run. A row abandoned in that window is a student who is
 * accepted in the database, never told, and no longer selectable by anything —
 * silently, permanently. So this route never starts a row it can't finish
 * inside the budget, and it puts the schedule BACK on any row that is still
 * `accepted` when its work gave up, which is what the `accepted` entry in the
 * claim query below is for.
 *
 * That retry is bounded on both sides, because a duplicate acceptance is only
 * the cheaper mistake while it stays a duplicate: a row is re-run only if the
 * audit trail proves THIS route accepted it, and only MAX_ACCEPT_ATTEMPTS
 * times. A student told twice can be apologised to; a student mailed every five
 * minutes until somebody notices cannot be untold.
 */
export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured — an open endpoint here
  // accepts real students and emails them on demand.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Rows still in a decidable state, plus `accepted`. Leaving `rejected` and
  // `waitlisted` out is a defensive guard on top of the clear-on-decide
  // contract: even if a row somehow kept its schedule after a manual decline,
  // this filter is what stops the cron overriding the human who wrote it.
  //
  // `accepted` has to be selectable because that is what a re-parked row looks
  // like (see `repark`), but the status does NOT by itself mean we parked it.
  // `autoAdmitOnSubmit` and both refund rollbacks (app/admin/students/[id]/
  // actions.ts, lib/stripe-fulfillment.ts) write `status = 'accepted'` and leave
  // scheduled_accept_* untouched — a parked application that got "waive fee &
  // enroll" and was later refunded lands here looking exactly like a retry. So
  // an accepted row is checked against the audit trail in the loop below before
  // anything re-runs; nothing is re-accepted on the strength of its status.
  //
  // Oldest first, and capped at a batch that fits the minute. Whatever a run
  // doesn't reach keeps its status AND its schedule (still `<= now`), so it
  // matches this exact query again on the next tick: deferring drops nothing.
  const { data: due, error } = await admin
    .from("applications")
    .select(
      "id, status, scheduled_accept_at, scheduled_accept_notes, scheduled_accept_by",
    )
    .not("scheduled_accept_at", "is", null)
    .lte("scheduled_accept_at", nowIso)
    .in("status", ["submitted", "draft", "waitlisted", "accepted"])
    .order("scheduled_accept_at", { ascending: true })
    .limit(DUE_BATCH_LIMIT);
  if (error) {
    console.error("[cron/scheduled-accepts]", error.message);
    return new Response(error.message, { status: 500 });
  }

  const rows = (due ?? []) as any[];
  let accepted = 0;
  let failed = 0;
  let deferred = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    // Stop STARTING rows near the limit rather than being killed inside one.
    // The remainder stays parked for the next tick; the count is reported so a
    // standing backlog is visible rather than merely slow.
    if (Date.now() - startedAt > BATCH_BUDGET_MS) {
      deferred = rows.length - i;
      break;
    }
    // Guard on the scheduler existing: reviewed_by / audit want a real actor.
    // A schedule with no scheduled_accept_by shouldn't be possible, but if the
    // FK was nulled (scheduler's profile deleted, on delete set null), skip
    // rather than accept anonymously.
    if (!a.scheduled_accept_by) {
      errors.push(`${a.id}: no scheduler on record, skipped`);
      continue;
    }
    // An already-accepted row is ours to re-run only if the audit trail shows
    // we ran it before, and only so many times. Zero attempts on record means
    // some other writer left the schedule behind (see the claim query), and
    // re-deciding one of those would mail a duplicate acceptance AND overwrite
    // a real reviewer's reviewed_by / reviewed_at / review_notes. An unreadable
    // count means we can't bound the retries, which gets the same answer.
    //
    // Nothing is written in any of the three cases: the row stays parked, the
    // line repeats in `errors` every tick until somebody acts, and the
    // application page shows the schedule with a Cancel button. Loud beats
    // clearing the columns, which is the silent drop this all exists to stop.
    if (a.status === "accepted") {
      const attempts = await acceptAttempts(admin, a.id);
      if (attempts === null) {
        errors.push(`${a.id}: can't count prior attempts, not retrying`);
        continue;
      }
      if (attempts === 0) {
        errors.push(
          `${a.id}: accepted by something other than this cron, schedule is stale — not re-accepting`,
        );
        continue;
      }
      if (attempts >= MAX_ACCEPT_ATTEMPTS) {
        errors.push(
          `${a.id}: ${attempts} acceptances on record, giving up — confirm the student was told, then cancel the schedule`,
        );
        continue;
      }
    }
    try {
      await withinBudget(
        applyApplicationDecision(
          a.id,
          "accepted",
          a.scheduled_accept_notes ?? "",
          a.scheduled_accept_by,
        ),
        ROW_BUDGET_MS,
      );
      accepted++;
    } catch (err: any) {
      failed++;
      errors.push(`${a.id}: ${err?.message ?? String(err)}`);
      await repark(admin, a);
    }
  }

  if (errors.length > 0) {
    console.error("[cron/scheduled-accepts]", errors.join("; "));
  }
  return NextResponse.json({
    due: rows.length,
    accepted,
    failed,
    deferred,
    errors,
  });
}

/**
 * Wait on one piece of work — a row's acceptance, or the bookkeeping either
 * side of it — for at most `budgetMs`.
 *
 * Nothing underneath carries a timeout of its own — not the Supabase fetch, not
 * Resend, not Discord — so a single hung upstream would otherwise spend the
 * whole invocation and take the rest of the batch down with it. Losing this
 * race does NOT cancel the work, it only stops us waiting on it, which is why
 * the caller re-parks: whatever finishes in the background either already
 * announced (and a retry is a duplicate email) or never will (and a retry is
 * the only thing that ever tells the student). From out here those two are
 * indistinguishable, which is exactly why the retry is capped.
 *
 * Takes a PromiseLike so a Supabase query builder can be passed directly.
 */
async function withinBudget<T>(
  work: PromiseLike<T>,
  budgetMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`gave up after ${budgetMs / 1000}s`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many times an acceptance has been COMMITTED for this application, read
 * off the audit log — the retry counter, with no column to migrate.
 *
 * `applyApplicationDecision` logs exactly one `application.accepted` row per
 * decision (lib/application-decisions.ts), immediately after the status write
 * and before the email, so the count is "attempts that got far enough to need
 * announcing" — which is precisely what a retry repeats. Auto-admits log
 * `application.auto_accepted` instead and so read as zero here, which is the
 * distinction the claim query leans on.
 *
 * Returns null when the count can't be read, and the caller treats that as
 * "leave this row alone": an unbounded retry loop mails a real student an
 * acceptance every five minutes and none of it can be taken back, while an
 * unannounced acceptance is visible (status `accepted`, schedule still parked,
 * a line in `errors`) and fixable by hand.
 */
async function acceptAttempts(
  admin: SupabaseClient,
  applicationId: string,
): Promise<number | null> {
  try {
    const { count, error } = await withinBudget(
      admin
        .from("audit_log")
        .select("id", { count: "exact", head: true })
        .eq("action", "application.accepted")
        .eq("target_type", "application")
        .eq("target_id", applicationId),
      BOOKKEEPING_BUDGET_MS,
    );
    if (error) throw new Error(error.message);
    // A null count from an exact/head query means we got a response we can't
    // read, not zero attempts — fail closed, same as an error.
    return count ?? null;
  } catch (err: any) {
    console.error(
      "[cron/scheduled-accepts] attempt count failed",
      applicationId,
      err?.message ?? String(err),
    );
    return null;
  }
}

/**
 * Put the parked acceptance back on a row whose acceptance didn't report
 * success, so the next tick can try again.
 *
 * `applyApplicationDecision` clears the schedule in the same statement that
 * commits `accepted`, and the email, in-app notification and Discord sync only
 * run after it — so a failure past that point leaves a student accepted with
 * nothing on record saying they were never told. Restoring the three columns
 * hands the row back to the claim query (which is why that query admits
 * `accepted` rows).
 *
 * Guarded on `status = 'accepted'`, because losing the row budget neither stops
 * the work nor freezes the row. The decision may never have committed, in which
 * case the schedule was never cleared and there is nothing to restore; or, in
 * the up-to-20s that work ran, an admin may have waitlisted or rejected this
 * application by hand — and re-parking THAT row would have the next tick accept
 * somebody a human just turned down, over their explicit decision. Matching
 * zero rows is the right outcome in both cases.
 */
async function repark(
  admin: SupabaseClient,
  a: {
    id: string;
    scheduled_accept_at: string | null;
    scheduled_accept_notes: string | null;
    scheduled_accept_by: string | null;
  },
) {
  try {
    const { error } = await withinBudget(
      admin
        .from("applications")
        .update({
          scheduled_accept_at: a.scheduled_accept_at,
          scheduled_accept_notes: a.scheduled_accept_notes,
          scheduled_accept_by: a.scheduled_accept_by,
        })
        .eq("id", a.id)
        .eq("status", "accepted"),
      BOOKKEEPING_BUDGET_MS,
    );
    if (error) throw new Error(error.message);
  } catch (err: any) {
    console.error(
      "[cron/scheduled-accepts] re-park failed, acceptance may be unannounced",
      a.id,
      err?.message ?? String(err),
    );
  }
}
