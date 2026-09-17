"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/server-guards";
import { runAction, type ActionResult } from "@/lib/action-result";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  saveScholarshipApplication,
  withdrawScholarshipApplication,
  sendScholarshipGuestTicket,
} from "@/lib/scholarships";

const PATH = "/dashboard/scholarships";

/**
 * The outcome of a save, from the form's point of view.
 *
 * Note this is the `data` side of a successful ActionResult even when the save
 * FAILED validation. That's deliberate: `runAction` converts a thrown error
 * into `{ ok: false, error }` with no room for a per-field map, and losing
 * which field was wrong is exactly what makes a long form miserable. A
 * validation failure is an ordinary outcome of submitting a form, not an
 * exception — so it travels as data. Genuine faults still throw.
 */
export type SaveOutcome =
  | { saved: true; applicationId: string; submitted: boolean }
  | { saved: false; error: string; fieldErrors: Record<string, string> };

/**
 * Save or submit the student's own scholarship application.
 *
 * `requireActor()` rather than a permission: this is a student acting on their
 * own row. Not `requireUser()` from lib/auth — that rides getClaims, so a
 * deleted or globally-signed-out account would keep writing here for up to an
 * hour; both actions below take the getUser() round trip instead, so
 * revocation is immediate (see lib/server-guards.ts). The user id comes from
 * the session and is never read from the payload — lib/scholarships.ts scopes
 * every write by it, so no shape of request lets someone apply as somebody
 * else.
 *
 * Eligibility, seat counts and the one-scholarship-per-student rule are all
 * re-checked inside saveScholarshipApplication. A server action is its own
 * entry point and is callable by anyone who can guess the action id, so the
 * page having rendered an apply button is not evidence of anything.
 */
export async function saveScholarshipApplicationAction(input: {
  slug: string;
  /** Keyed by bare question id — the client strips the form prefix. */
  answers: Record<string, unknown>;
  submit: boolean;
}): Promise<ActionResult<SaveOutcome>> {
  return runAction({ name: "saveScholarshipApplication" }, async () => {
    const { userId } = await requireActor();

    // Same shape of limit as the /apply draft autosave (30/min): a form that
    // saves as you type needs headroom, but not unbounded headroom.
    const rl = await checkRateLimit({
      kind: "scholarship-save",
      identifier: userId,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) throw new Error("Too many saves. Give it a moment.");

    const result = await saveScholarshipApplication({
      userId,
      slug: input.slug,
      answers: input.answers,
      submit: input.submit,
    });

    if (!result.ok) {
      return {
        saved: false as const,
        error: result.error,
        fieldErrors: result.errors ?? {},
      };
    }

    revalidatePath(PATH);
    revalidatePath(`${PATH}/${input.slug}`);
    return {
      saved: true as const,
      applicationId: result.applicationId,
      submitted: input.submit,
    };
  });
}

export async function withdrawScholarshipApplicationAction(
  applicationId: string,
): Promise<ActionResult> {
  return runAction({ name: "withdrawScholarshipApplication" }, async () => {
    const { userId } = await requireActor();
    const result = await withdrawScholarshipApplication({
      userId,
      applicationId,
    });
    if (!result.ok) throw new Error(result.error);
    revalidatePath(PATH);
  });
}

/**
 * Send one of the student's complimentary Demo Day guest tickets (0074).
 *
 * The award it draws on is looked up from the session, never from the
 * payload, so nobody can spend another student's tickets. Rate-limited a
 * little harder than the autosave: every call that gets past the balance
 * check sends a real email to a stranger, and a stuck retry loop must not be
 * able to turn one guest into a mailbox full of invitations.
 */
export async function sendGuestTicketAction(input: {
  email: string;
  name: string;
}): Promise<ActionResult<{ remaining: number }>> {
  return runAction({ name: "sendGuestTicket" }, async () => {
    const { userId } = await requireActor();

    const rl = await checkRateLimit({
      kind: "scholarship-guest-ticket",
      identifier: userId,
      limit: 10,
      windowSeconds: 60 * 10,
    });
    if (!rl.ok) throw new Error("That's a lot of tickets at once. Give it a few minutes.");

    const result = await sendScholarshipGuestTicket({
      userId,
      guestEmail: input.email,
      guestName: input.name,
    });
    if (!result.ok) throw new Error(result.error);

    revalidatePath(PATH);
    return { remaining: result.remaining };
  });
}
