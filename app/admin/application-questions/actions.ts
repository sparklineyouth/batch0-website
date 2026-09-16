"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  QUESTION_FIELD_MAP,
  QUESTION_FIELDS,
  APPLICATION_QUESTIONS_SETTING,
  isRequiredCore,
  type QuestionOverride,
  type ApplicationQuestionsOverrides,
  type ApplicationQuestionsConfig,
} from "@/lib/application-questions";
import {
  normalizeQuestions,
  validateQuestionList,
  MAX_QUESTIONS,
  type CustomQuestion,
} from "@/lib/question-schema";
import {
  SCHOLARSHIP_INTEREST_SETTING,
  getScholarshipById,
} from "@/lib/scholarships";

const LABEL_MAX = 200;
const HELP_MAX = 600;
const PLACEHOLDER_MAX = 200;
const OPTION_LABEL_MAX = 120;

const PATH = "/admin/application-questions";

/**
 * Validate the admin's edits to the 17 built-in, column-backed fields.
 *
 * Structure is not negotiable here: unknown keys are rejected outright and
 * option VALUES must match the code skeleton, because both are load-bearing
 * for the DB mapping and for SubmitSchema. Only content changes.
 *
 * What IS new since the questions became removable: `hidden` is now a
 * legitimate value for the twelve non-core fields. It takes the field off the
 * form and stops collecting it, and deliberately does nothing to the column —
 * every answer already gathered stays readable in the review queue.
 */
function cleanBuiltins(
  input: ApplicationQuestionsOverrides,
): ApplicationQuestionsOverrides {
  const clean: ApplicationQuestionsOverrides = {};

  for (const [key, raw] of Object.entries(input ?? {})) {
    const base = QUESTION_FIELD_MAP[key];
    if (!base) throw new Error(`Unknown field: ${key}`);
    if (!raw || typeof raw !== "object") {
      throw new Error(`Invalid config for ${key}`);
    }

    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) throw new Error(`${base.key}: label can't be empty`);
    if (label.length > LABEL_MAX) throw new Error(`${base.key}: label is too long`);

    const help = typeof raw.help === "string" ? raw.help : "";
    if (help.length > HELP_MAX) throw new Error(`${base.key}: help text is too long`);

    const placeholder = typeof raw.placeholder === "string" ? raw.placeholder : "";
    if (placeholder.length > PLACEHOLDER_MAX) {
      throw new Error(`${base.key}: placeholder is too long`);
    }

    let required = typeof raw.required === "boolean" ? raw.required : base.required;
    let hidden = typeof raw.hidden === "boolean" ? raw.hidden : base.hidden;

    // The five server-authoritative cores can never be made optional or
    // removed — SubmitSchema would reject the resulting submissions, and the
    // applicant would see a failure with no field on screen to fix.
    if (isRequiredCore(base.key)) {
      if (hidden) {
        throw new Error(
          `"${base.label}" is one of the five fields the application can't work without, so it can't be removed.`,
        );
      }
      if (!required) {
        throw new Error(
          `"${base.label}" is one of the five fields the application can't work without, so it can't be made optional.`,
        );
      }
      required = true;
      hidden = false;
    }

    // A removed field is not also required. Harmless for a built-in (it's
    // simply not rendered or validated), but storing the contradiction means
    // un-removing it later silently makes it required again.
    if (hidden) required = false;

    const override: QuestionOverride = { label, help, placeholder, required, hidden };

    // team_size: only the option LABELS are editable. The VALUES and the set
    // of options must match the code skeleton exactly.
    if (base.options) {
      const validValues = new Set(base.options.map((o) => String(o.value)));
      const optionLabels: Record<string, string> = {};
      const incoming =
        raw.optionLabels && typeof raw.optionLabels === "object"
          ? raw.optionLabels
          : {};
      for (const [val, lbl] of Object.entries(incoming)) {
        if (!validValues.has(val)) {
          throw new Error(`${base.key}: option "${val}" isn't a valid choice`);
        }
        const trimmed = typeof lbl === "string" ? lbl.trim() : "";
        if (!trimmed) throw new Error(`${base.key}: option "${val}" label can't be empty`);
        if (trimmed.length > OPTION_LABEL_MAX) {
          throw new Error(`${base.key}: option "${val}" label is too long`);
        }
        optionLabels[val] = trimmed;
      }
      for (const opt of base.options) {
        if (!optionLabels[String(opt.value)]) {
          throw new Error(`${base.key}: every option needs a label`);
        }
      }
      override.optionLabels = optionLabels;
    }

    clean[key] = override;
  }

  // Persist an entry for every known field so the stored config is complete
  // and self-describing. Readers still tolerate gaps.
  for (const field of QUESTION_FIELDS) {
    if (!clean[field.key]) throw new Error(`Missing config for ${field.key}`);
  }

  return clean;
}

/**
 * Validate an admin-authored question list. Shared by the /apply custom
 * section, the shared scholarship-interest block, and each scholarship's own
 * questions — all three are the same shape, so all three get the same checks.
 */
function cleanCustom(input: unknown, what: string): CustomQuestion[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_QUESTIONS) {
    throw new Error(`${what}: too many questions (max ${MAX_QUESTIONS}).`);
  }

  // Coerce to the canonical shape first so a missing `options: []` or a
  // stringified boolean from the form doesn't read as a validation failure.
  const coerced: CustomQuestion[] = list.map((raw: any) => ({
    id: typeof raw?.id === "string" ? raw.id.trim() : "",
    type: raw?.type,
    label: typeof raw?.label === "string" ? raw.label.trim() : "",
    help: typeof raw?.help === "string" ? raw.help : "",
    placeholder: typeof raw?.placeholder === "string" ? raw.placeholder : "",
    required: raw?.required === true,
    hidden: raw?.hidden === true,
    options: Array.isArray(raw?.options)
      ? raw.options.map((o: any) => ({
          value: typeof o?.value === "string" ? o.value.trim() : "",
          label: typeof o?.label === "string" ? o.label.trim() : "",
        }))
      : [],
  }));

  const err = validateQuestionList(coerced);
  if (err) throw new Error(`${what}: ${err}`);
  return coerced;
}

/** Upsert one `site_settings` row. Mirrors saveSiteSettings. */
async function putSetting(key: string, value: unknown) {
  const admin = createAdminClient();
  const { error } = await admin.from("site_settings").upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) throw new Error(`Save failed: ${error.message}`);
}

/**
 * Save the /apply form: the 17 built-ins plus the admin's own questions.
 *
 * Written as one action rather than one per question so the whole form is
 * saved atomically — a partial save that added a question but lost a label
 * edit would be worse than a rejected one.
 *
 * Returns the custom questions as stored, ids and all, for the editor to adopt.
 * Only the built-ins are keyed by something the client already knows; a custom
 * question's id may have been derived here, and the client has to end up
 * holding that exact key — see validateQuestionList.
 */
export async function saveApplicationQuestions(input: {
  builtins: ApplicationQuestionsOverrides;
  custom: unknown;
}): Promise<ActionResult<CustomQuestion[]>> {
  return runAction({ name: "saveApplicationQuestions" }, async () => {
    await assertPermission("applications.form");

    if (!input || typeof input !== "object") {
      throw new Error("Invalid questions payload");
    }

    const config: ApplicationQuestionsConfig = {
      version: 2,
      builtins: cleanBuiltins(input.builtins),
      custom: cleanCustom(input.custom, "Your questions"),
    };

    await putSetting(APPLICATION_QUESTIONS_SETTING, config);

    await logAudit({
      action: "application_questions.updated",
      payload: {
        removed: Object.entries(config.builtins)
          .filter(([, v]) => v.hidden)
          .map(([k]) => k),
        custom_count: config.custom.length,
        custom_ids: config.custom.map((q) => q.id),
      },
    });

    revalidatePath("/apply");
    revalidatePath(PATH);
    return config.custom;
  });
}

/**
 * Save the shared scholarship block shown to every applicant on /apply.
 *
 * Separate setting, separate action, because this block is asked BEFORE anyone
 * is accepted and can therefore only flag interest — the real, scholarship-
 * specific questions live on the scholarship itself and are saved below.
 *
 * Returns the list as stored so the editor can adopt any id derived here.
 */
export async function saveScholarshipInterestQuestions(
  input: unknown,
): Promise<ActionResult<CustomQuestion[]>> {
  return runAction({ name: "saveScholarshipInterestQuestions" }, async () => {
    await assertPermission("applications.form");
    const questions = cleanCustom(input, "Scholarship questions");
    await putSetting(SCHOLARSHIP_INTEREST_SETTING, questions);

    await logAudit({
      action: "scholarship_interest_questions.updated",
      payload: { count: questions.length, ids: questions.map((q) => q.id) },
    });

    revalidatePath("/apply");
    revalidatePath(PATH);
    return questions;
  });
}

/**
 * Save one scholarship's own extra questions.
 *
 * Gated on `scholarships.manage` rather than `applications.form`: these
 * questions decide who gets money, so editing them is a scholarship power, not
 * a form-editing one. The two sections sit on the same admin page for
 * convenience; they do not share a permission.
 *
 * Returns the list as stored so the editor can adopt any id derived here.
 */
export async function saveScholarshipQuestions(
  scholarshipId: string,
  input: unknown,
): Promise<ActionResult<CustomQuestion[]>> {
  return runAction({ name: "saveScholarshipQuestions" }, async () => {
    await assertPermission("scholarships.manage");

    const admin = createAdminClient();
    const scholarship = await getScholarshipById(admin, scholarshipId);
    if (!scholarship) throw new Error("That scholarship doesn't exist.");

    const questions = cleanCustom(input, `"${scholarship.name}"`);

    const { error } = await admin
      .from("scholarships")
      .update({ questions })
      .eq("id", scholarshipId);
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "scholarship.questions_updated",
      targetType: "scholarship",
      targetId: scholarshipId,
      payload: { count: questions.length, ids: questions.map((q) => q.id) },
    });

    revalidatePath(PATH);
    revalidatePath("/admin/scholarships");
    revalidatePath(`/dashboard/scholarships/${scholarship.slug}`);
    return questions;
  });
}

/** Re-read one scholarship's questions, for the section's dropdown. */
export async function loadScholarshipQuestions(
  scholarshipId: string,
): Promise<ActionResult<CustomQuestion[]>> {
  return runAction({ name: "loadScholarshipQuestions" }, async () => {
    await assertPermission("scholarships.view");
    const admin = createAdminClient();
    const { data } = await admin
      .from("scholarships")
      .select("questions")
      .eq("id", scholarshipId)
      .maybeSingle();
    return normalizeQuestions((data as any)?.questions);
  });
}
