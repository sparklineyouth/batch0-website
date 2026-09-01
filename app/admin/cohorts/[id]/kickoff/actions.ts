"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import {
  KICKOFF_COLUMNS,
  isSafeHref,
  type KickoffAgendaItem,
  type KickoffChecklistItem,
} from "@/lib/kickoff";

export type KickoffInput = {
  cohortId: string;
  headline: string;
  intro: string;
  time_label: string;
  location_label: string;
  join_url: string;
  agenda: KickoffAgendaItem[];
  checklist: KickoffChecklistItem[];
  note: string;
};

// Caps, not validation theatre: these fields render into a fixed page layout
// and live in a jsonb column read on every kickoff view. A 400-row agenda is a
// mistake, not a use case.
const MAX_ROWS = 12;
const MAX_SHORT = 200;
const MAX_LONG = 2000;

function clean(v: string | null | undefined, max: number): string | null {
  const s = (v ?? "").trim().slice(0, max);
  return s.length > 0 ? s : null;
}

/**
 * Save the kickoff content for one cohort.
 *
 * Every field is optional. Clearing one writes null, which puts that piece of
 * the page back on its built-in default (see lib/kickoff.ts) — so "reset this"
 * is just "empty the box", and there is no state in which the student's page
 * comes out blank.
 */
export async function saveKickoff(input: KickoffInput) {
  await assertPermission("cohorts.manage");

  const joinUrl = clean(input.join_url, MAX_SHORT);
  if (joinUrl && !/^https:\/\/[^\s]+$/i.test(joinUrl)) {
    throw new Error("The join link must be a full https:// URL.");
  }

  const agenda: KickoffAgendaItem[] = (input.agenda ?? [])
    .map((r) => ({
      title: clean(r?.title, MAX_SHORT) ?? "",
      body: clean(r?.body, MAX_LONG) ?? "",
    }))
    // A row with no title has nothing to render as a heading — treat it as an
    // unfilled row the admin left behind rather than an error to shout about.
    .filter((r) => r.title.length > 0)
    .slice(0, MAX_ROWS);

  const checklistRaw = (input.checklist ?? [])
    .map((r) => ({
      label: clean(r?.label, MAX_SHORT) ?? "",
      href: clean(r?.href, MAX_SHORT) ?? "",
    }))
    .filter((r) => r.label.length > 0 || r.href.length > 0);

  for (const r of checklistRaw) {
    if (!r.label || !r.href) {
      throw new Error(
        "Every checklist row needs both a label and a link. Delete the row to remove it.",
      );
    }
    if (!isSafeHref(r.href)) {
      throw new Error(
        `"${r.href}" isn't a valid link. Use an in-app path like /dashboard/team, or a full https:// URL.`,
      );
    }
  }
  const checklist: KickoffChecklistItem[] = checklistRaw.slice(0, MAX_ROWS);

  const payload = {
    headline: clean(input.headline, MAX_SHORT),
    intro: clean(input.intro, MAX_LONG),
    time_label: clean(input.time_label, MAX_SHORT),
    location_label: clean(input.location_label, MAX_SHORT),
    join_url: joinUrl,
    // Null, not [], when the admin has cleared a list — null is what
    // resolveKickoff() reads as "use the default", where an empty array would
    // instead render an empty section.
    agenda: agenda.length > 0 ? agenda : null,
    checklist: checklist.length > 0 ? checklist : null,
    note: clean(input.note, MAX_LONG),
  };

  const admin = createAdminClient();

  // The cohort must exist. Without this an id typo would insert an orphan row
  // — except the FK catches it, and a raw FK violation is not an error message
  // anyone should have to read.
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id")
    .eq("id", input.cohortId)
    .maybeSingle();
  if (!cohort) throw new Error("That cohort no longer exists.");

  const { data: before } = await admin
    .from("cohort_kickoff")
    .select(KICKOFF_COLUMNS)
    .eq("cohort_id", input.cohortId)
    .maybeSingle();

  // Upsert: the row is created the first time an admin saves anything, so an
  // untouched cohort carries no row at all and reads as pure defaults.
  const { error } = await admin
    .from("cohort_kickoff")
    .upsert(
      { cohort_id: input.cohortId, ...payload, updated_at: new Date().toISOString() },
      { onConflict: "cohort_id" },
    );
  if (error) {
    // Migrations here are applied by hand in the Supabase SQL editor, so the
    // deployed code can legitimately be ahead of the schema. Name the file to
    // run rather than surfacing a raw PostgREST relation error to an admin.
    if (
      /cohort_kickoff/.test(error.message) ||
      /schema cache/i.test(error.message)
    ) {
      throw new Error(
        "The kickoff table doesn't exist yet — run supabase/migrations/0049_cohort_kickoff_content.sql in the Supabase SQL editor, then save again.",
      );
    }
    throw new Error(error.message);
  }

  await logAudit({
    action: "cohort.kickoff_updated",
    targetType: "cohort",
    targetId: input.cohortId,
    payload: { before: before ?? {}, after: payload },
  });

  revalidatePath(`/admin/cohorts/${input.cohortId}/kickoff`);
  revalidatePath("/dashboard/kickoff");
}
