"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { runAction, type ActionResult } from "@/lib/action-result";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  saveScholarshipApplication,
  withdrawScholarshipApplication,
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
 * `requireUser()` rather than a permission: this is a student acting on their
 * own row. The user id comes from the session and is never read from the
 * payload — lib/scholarships.ts scopes every write by it, so no shape of
 * request lets someone apply as somebody else.
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
    const user = await requireUser();

    // Same shape of limit as the /apply draft autosave (30/min): a form that
    // saves as you type needs headroom, but not unbounded headroom.
    const rl = await checkRateLimit({
      kind: "scholarship-save",
      identifier: user.id,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) throw new Error("Too many saves. Give it a moment.");

    const result = await saveScholarshipApplication({
      userId: user.id,
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
    const user = await requireUser();
    const result = await withdrawScholarshipApplication({
      userId: user.id,
      applicationId,
    });
    if (!result.ok) throw new Error(result.error);
    revalidatePath(PATH);
  });
}
