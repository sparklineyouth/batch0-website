import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { cohortHasStarted, fmtDateOnly, todayISO } from "@/lib/pre-cohort";
import {
  parseAgenda,
  parseChecklist,
  readKickoffRow,
  resolveKickoff,
} from "@/lib/kickoff";
import { KickoffForm } from "./kickoff-form";

export const metadata = { title: "Cohort kickoff · Admin" };

type CohortRow = {
  id: string;
  name: string | null;
  starts_on: string | null;
  status: string | null;
};

export default async function CohortKickoffPage({
  params,
}: {
  params: { id: string };
}) {
  // `cohorts.manage` — the same permission the landing editor and the cohort
  // list use. ADMIN_ROUTE_PERMISSIONS already maps the /admin/cohorts prefix to
  // it, so the middleware and the admin layout gate this route too, and no new
  // permission key has to be granted to any existing role.
  await requirePermission("cohorts.manage");

  const admin = createAdminClient();
  const { data } = await admin
    .from("cohorts")
    .select("id, name, starts_on, status")
    .eq("id", params.id)
    .maybeSingle();
  const cohort = (data as CohortRow) ?? null;
  if (!cohort) notFound();

  // Separate, failure-tolerant read — see readKickoffRow. Until migration 0049
  // is applied this returns null and the editor opens on empty fields, which
  // is exactly what an unedited cohort looks like anyway.
  const k = await readKickoffRow(admin, cohort.id);

  const today = todayISO();
  // Resolve once with everything cleared, so the form can show the admin the
  // exact heading a student would see if they wrote nothing.
  const fallback = resolveKickoff(
    null,
    {
      name: cohort.name,
      startsOn: cohort.starts_on,
      status: cohort.status,
      started: cohortHasStarted(cohort, today),
    },
    today,
  );

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/cohorts"
        className="text-sm text-ink-faint hover:text-ink"
      >
        ← Cohorts
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        {cohort.name} kickoff
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        What enrolled students see at{" "}
        <Link
          href="/dashboard/kickoff"
          className="text-phosphor-ink hover:underline"
        >
          /dashboard/kickoff
        </Link>
        . <PhaseNote phase={fallback.phase} startsOn={cohort.starts_on} />
      </p>
      <Card className="mt-6">
        <KickoffForm
          defaultHeadline={fallback.headline}
          initial={{
            cohortId: cohort.id,
            headline: k?.headline ?? "",
            intro: k?.intro ?? "",
            time_label: k?.time_label ?? "",
            location_label: k?.location_label ?? "",
            join_url: k?.join_url ?? "",
            agenda: parseAgenda(k?.agenda) ?? [],
            checklist: parseChecklist(k?.checklist) ?? [],
            note: k?.note ?? "",
          }}
        />
      </Card>
    </div>
  );
}

/** Say plainly which version of the page this cohort's students are seeing. */
function PhaseNote({
  phase,
  startsOn,
}: {
  phase: string;
  startsOn: string | null;
}) {
  const date = fmtDateOnly(startsOn);
  if (phase === "cancelled") {
    return <>This cohort is cancelled, so students see a short notice instead of the agenda.</>;
  }
  if (phase === "undated") {
    return (
      <>
        This cohort has no start date yet, so the page says kickoff is being
        scheduled. Set a date on the cohort to show a countdown.
      </>
    );
  }
  if (phase === "today") return <>Kickoff is today.</>;
  if (phase === "past") {
    return <>This cohort started {date}, so the page reads as the record of day one.</>;
  }
  return <>Kicks off {date} — students see a countdown until then.</>;
}
