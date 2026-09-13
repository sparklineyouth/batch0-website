"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { friendlyAuthError } from "@/lib/auth-errors";
import { makePlaceholderEmail } from "@/lib/placeholder-email";
import type { ActionResult } from "@/lib/action-result";

const CreatePersonSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required").max(120),
  // Optional. Empty string is allowed and treated as "no email" — the account
  // gets a non-deliverable placeholder address instead.
  email: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || /^\S+@\S+\.\S+$/.test(v), "Enter a valid email")
    .optional()
    .or(z.literal("")),
  // Free text to match applications.grade ("10th", "College freshman", …).
  grade: z.string().trim().max(40).optional().or(z.literal("")),
  // Optional cohort to enrol them into at the same time. Empty = just add the
  // person; no enrolment row is created.
  cohort_id: z.string().uuid().optional().or(z.literal("")),
});

export type CreatePersonInput = z.infer<typeof CreatePersonSchema>;

export type CreatedPerson = {
  id: string;
  full_name: string;
  /** Real email, or null when the person was added without one. */
  email: string | null;
  grade: string | null;
  /** Cohort name they were enrolled into, or null. */
  cohort_name: string | null;
};

/**
 * Create a batch0 person on someone's behalf and, optionally, enrol them into
 * a cohort in the same step — the "Enroll them" action in /admin/students/new.
 *
 * The account is minted with the service-role admin API and pre-confirmed, so
 * the `on_auth_user_created` trigger builds the matching `profiles` row exactly
 * as a normal signup would. No password is set and no email is sent: these are
 * roster records an admin manages. If a real email is on file, the admin can
 * later "Send password reset" from the person's page to let them sign in.
 */
export async function createPerson(
  input: CreatePersonInput,
): Promise<ActionResult<CreatedPerson>> {
  try {
    await assertPermission("people.manage");

    const parsed = CreatePersonSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Check the form and retry.",
      };
    }
    const fullName = parsed.data.full_name;
    const realEmail = parsed.data.email
      ? parsed.data.email.toLowerCase()
      : null;
    const grade = parsed.data.grade || null;
    const cohortId = parsed.data.cohort_id || null;

    const admin = createAdminClient();

    // Validate the cohort up front so we don't create an orphaned account when
    // the enrolment target is bad.
    let cohortName: string | null = null;
    if (cohortId) {
      const { data: cohort } = await admin
        .from("cohorts")
        .select("id, name")
        .eq("id", cohortId)
        .maybeSingle();
      if (!cohort) return { ok: false, error: "That cohort no longer exists." };
      cohortName = cohort.name;
    }

    // Mint the auth user. A person with no email still needs one (the column
    // is NOT NULL and auth.users requires it), so synthesize a non-deliverable
    // placeholder — the UI hides it and nothing is ever sent to it.
    const email = realEmail ?? makePlaceholderEmail();
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
    if (createErr || !created?.user) {
      return { ok: false, error: friendlyAuthError(createErr) };
    }
    const userId = created.user.id;

    // The trigger already created the profile with email + full_name; add the
    // grade the trigger doesn't know about (and re-assert full_name in case a
    // future trigger change drops it).
    const { error: profileErr } = await admin
      .from("profiles")
      .update({ full_name: fullName, grade })
      .eq("id", userId);
    if (profileErr) {
      // The account exists but the grade didn't stick — surface it rather than
      // silently dropping the field. The admin can edit later; don't roll back
      // an otherwise-created person.
      console.error("[createPerson] profile update failed", profileErr);
    }

    if (cohortId) {
      const { error: enrollErr } = await admin.from("enrollments").upsert(
        { user_id: userId, cohort_id: cohortId },
        { onConflict: "user_id,cohort_id" },
      );
      if (enrollErr) {
        return {
          ok: false,
          error: `Account created, but enrolment failed: ${enrollErr.message}`,
        };
      }
    }

    await logAudit({
      action: "user.created_by_admin",
      targetType: "profile",
      targetId: userId,
      payload: {
        full_name: fullName,
        email: realEmail,
        has_email: realEmail !== null,
        grade,
        cohort_id: cohortId,
      },
    });

    revalidatePath("/admin/students");
    revalidatePath("/admin");

    return {
      ok: true,
      data: {
        id: userId,
        full_name: fullName,
        email: realEmail,
        grade,
        cohort_name: cohortName,
      },
    };
  } catch (err: any) {
    const message =
      err instanceof Error && err.message ? err.message : "Something went wrong.";
    console.error("[action:createPerson]", message, err);
    return { ok: false, error: message };
  }
}
