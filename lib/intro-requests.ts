// ---------------------------------------------------------------------------
// Investor → team intro requests (intro_requests, migration 0011): what one
// more request from an investor does. Import-free, so `node --test` runs it.
// ---------------------------------------------------------------------------

/**
 * How many intros one investor may have waiting on the batch0 team at once.
 *
 * Every request lands in one admin queue (/admin/intros) that a small team
 * works through by hand, and an investor at Demo Day can ask for an intro to
 * every team on the bill in a minute. Five keeps one enthusiastic investor
 * from burying everyone else's requests, and is no ceiling on interest: a
 * slot frees the moment the team makes the intro or passes, and the investor
 * can ask again.
 *
 * A soft cap — two requests landing in the same instant can both see four —
 * which is fine for what it is for.
 */
export const MAX_OPEN_INTRO_REQUESTS = 5;

export type IntroStatus = "requested" | "intro_made" | "meeting_held" | "committed" | "wired" | "passed";

export type IntroDecision =
  /** A new request: file it and tell the admins. */
  | { kind: "create" }
  /** Still waiting on the team: the investor is just rewording it. No new bell. */
  | { kind: "update-message" }
  | { kind: "refuse"; message: string };

/**
 * `existing` is this investor's row for this team, if any; `openCount` is how
 * many of their requests are still `requested`, this team's included.
 *
 * A row the team has already moved on (intro made, met, committed, passed) is
 * never put back to `requested`. The old upsert did exactly that, from a
 * second tab or a double-submit: an intro already made silently reappeared in
 * the queue as new, and a pass looked like a fresh ask.
 */
export function introRequestDecision(args: {
  existing: { status: string } | null;
  openCount: number;
}): IntroDecision {
  if (args.existing) {
    if (args.existing.status === "requested") return { kind: "update-message" };
    return {
      kind: "refuse",
      message: "The batch0 team has already acted on your intro request for this team. Check its status under Intros.",
    };
  }
  if (args.openCount >= MAX_OPEN_INTRO_REQUESTS) {
    return {
      kind: "refuse",
      message: `You have ${MAX_OPEN_INTRO_REQUESTS} intro requests waiting on the batch0 team. Once we've acted on one, you can ask for another.`,
    };
  }
  return { kind: "create" };
}
