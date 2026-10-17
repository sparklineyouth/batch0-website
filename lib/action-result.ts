import { unstable_rethrow } from "next/navigation";

/**
 * Standard return shape for server actions that can fail with a
 * user-meaningful error.
 *
 * Why this exists: Next.js production builds strip the `message` from
 * any error thrown inside a server action — the client only ever sees a
 * generic "An error occurred in the Server Components render…" string
 * with a digest. That's bad UX (the user can't see *why* the action
 * failed) and bad debugging (the cause is hidden unless you have
 * Sentry/Vercel-log access). Server actions that return an
 * `ActionResult` instead of throwing surface the real message to the
 * client.
 */
export type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export type ActionContext = {
  /** Short label included in the server log line. */
  name: string;
};

/**
 * A rule saying no to what the person asked for — "That time is in the
 * past.", "Tell us what's wrong so we can act on it." — as opposed to
 * something going wrong.
 *
 * runAction hands both back the same way, as `{ ok: false, error }` the form
 * shows inline. The difference is the log: a failure is logged at error level
 * so it reaches Vercel's error view and Sentry, while a refusal is the action
 * working as designed and is not logged at all. Before this existed every
 * validation message was a production "error" — an admin picking a past time
 * on /admin/calls, a student sending an empty report — and the real faults
 * were buried among them.
 *
 * Use it only for messages written for the person. A database error or an
 * unexpected state stays a plain `throw new Error(...)`, so it keeps being
 * logged.
 *
 * Branded rather than matched with `instanceof`, so the check holds however
 * the bundler splits this module between chunks.
 */
export class ActionRefusal extends Error {
  readonly refusal = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ActionRefusal";
  }
}

/** Throw an ActionRefusal: `if (bad) refuse("Pick a time in the future.")`. */
export function refuse(message: string): never {
  throw new ActionRefusal(message);
}

export function isRefusal(err: unknown): err is ActionRefusal {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { refusal?: unknown }).refusal === true &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

/**
 * Run a server-action body and convert any thrown Error into a
 * structured failure result. Logs the underlying error server-side so
 * it shows up in Vercel function logs / Sentry regardless of whether
 * the client sees the (already structured) message.
 *
 * Framework control-flow errors are the one exception: they are
 * re-thrown, not converted. See the catch block.
 */
export async function runAction<T>(
  ctx: ActionContext,
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err: any) {
    // `redirect()` and `notFound()` signal by throwing, so a guard that
    // redirects — `requireUser()` sending a signed-out student to /login
    // — lands here and, without this, is reported back as an ordinary
    // failure: the user reads the literal string "NEXT_REDIRECT" and the
    // navigation never happens. Next's own predicate is what to use
    // rather than matching the digest ourselves, because the set of
    // shapes it throws (and their digests) changes between releases —
    // 15.x already emits "NEXT_HTTP_ERROR_FALLBACK;404" for notFound()
    // rather than the "NEXT_NOT_FOUND" older code looked for.
    unstable_rethrow(err);
    // A refusal is the answer, not a fault: hand it back, log nothing.
    if (isRefusal(err)) return { ok: false, error: err.message };
    const message =
      err instanceof Error && err.message
        ? err.message
        : typeof err === "string"
          ? err
          : "Something went wrong. Try again.";
    // Server-side log so Vercel logs / Sentry capture the cause even
    // though we return a friendly shape to the client.
    console.error(`[action:${ctx.name}]`, message, err);
    return { ok: false, error: message };
  }
}
