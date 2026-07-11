"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";
import {
  QUESTION_FIELD_MAP,
  QUESTION_FIELDS,
  isRequiredCore,
  type QuestionOverride,
  type ApplicationQuestionsOverrides,
} from "@/lib/application-questions";

const LABEL_MAX = 200;
const HELP_MAX = 600;
const PLACEHOLDER_MAX = 200;
const OPTION_LABEL_MAX = 120;

/**
 * Persist admin edits to the application questions. Admins can only change
 * CONTENT — this validates that structure is untouched (known keys, option
 * VALUES unchanged) and that the four server-required cores stay required +
 * visible, then upserts the single site_settings row (copying saveSiteSettings)
 * and audits the change.
 */
export async function saveApplicationQuestions(
  input: ApplicationQuestionsOverrides,
): Promise<ActionResult> {
  return runAction({ name: "saveApplicationQuestions" }, async () => {
    await assertAdmin();

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid questions payload");
    }

    const clean: ApplicationQuestionsOverrides = {};

    for (const [key, raw] of Object.entries(input)) {
      const base = QUESTION_FIELD_MAP[key];
      // Reject unknown keys outright — admins can't add fields.
      if (!base) {
        throw new Error(`Unknown field: ${key}`);
      }
      if (!raw || typeof raw !== "object") {
        throw new Error(`Invalid config for ${key}`);
      }

      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      if (!label) {
        throw new Error(`${base.key}: label can't be empty`);
      }
      if (label.length > LABEL_MAX) {
        throw new Error(`${base.key}: label is too long`);
      }

      const help = typeof raw.help === "string" ? raw.help : "";
      if (help.length > HELP_MAX) {
        throw new Error(`${base.key}: help text is too long`);
      }

      const placeholder =
        typeof raw.placeholder === "string" ? raw.placeholder : "";
      if (placeholder.length > PLACEHOLDER_MAX) {
        throw new Error(`${base.key}: placeholder is too long`);
      }

      let required =
        typeof raw.required === "boolean" ? raw.required : base.required;
      let hidden = typeof raw.hidden === "boolean" ? raw.hidden : base.hidden;

      // The four server-authoritative cores can never be made optional or
      // hidden — the SubmitSchema would reject the resulting submissions.
      if (isRequiredCore(base.key)) {
        if (hidden) {
          throw new Error(`${base.key} is required and can't be hidden`);
        }
        if (!required) {
          throw new Error(`${base.key} is required and can't be made optional`);
        }
        required = true;
        hidden = false;
      }

      const override: QuestionOverride = {
        label,
        help,
        placeholder,
        required,
        hidden,
      };

      // team_size: only the option LABELS are editable. The VALUES + set of
      // options must exactly match the code skeleton.
      if (base.options) {
        const validValues = new Set(base.options.map((o) => String(o.value)));
        const optionLabels: Record<string, string> = {};
        const incoming =
          raw.optionLabels && typeof raw.optionLabels === "object"
            ? raw.optionLabels
            : {};
        for (const [val, lbl] of Object.entries(incoming)) {
          if (!validValues.has(val)) {
            throw new Error(
              `${base.key}: option "${val}" isn't a valid choice`,
            );
          }
          const trimmed = typeof lbl === "string" ? lbl.trim() : "";
          if (!trimmed) {
            throw new Error(`${base.key}: option "${val}" label can't be empty`);
          }
          if (trimmed.length > OPTION_LABEL_MAX) {
            throw new Error(`${base.key}: option "${val}" label is too long`);
          }
          optionLabels[val] = trimmed;
        }
        // Require a label for every fixed option so we can't render a blank.
        for (const opt of base.options) {
          if (!optionLabels[String(opt.value)]) {
            throw new Error(
              `${base.key}: every option needs a label`,
            );
          }
        }
        override.optionLabels = optionLabels;
      }

      clean[key] = override;
    }

    // Ensure we always persist an entry for every known field so the stored
    // config is complete + self-describing (readers still tolerate gaps).
    for (const field of QUESTION_FIELDS) {
      if (!clean[field.key]) {
        throw new Error(`Missing config for ${field.key}`);
      }
    }

    const admin = createAdminClient();
    const { error } = await admin.from("site_settings").upsert(
      {
        key: "application_questions",
        value: clean,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "application_questions.updated",
      payload: clean,
    });

    revalidatePath("/apply");
    revalidatePath("/admin/application-questions");
  });
}
