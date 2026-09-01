import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { BlastForm } from "./blast-form";

export const metadata = { title: "Email blast · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Blast sends go out via Resend's batch API (1 request / 100 emails),
// but give the action segment breathing room for big lists anyway.
export const maxDuration = 60;

export default async function AdminEmailBlastPage() {
  // Recipients are resolved on demand by the getRecipients action once the
  // admin picks an audience — serializing the whole joined directory into the
  // form's props made this page's payload scale with total signups. All the
  // page itself needs is the cohort names for the filter dropdown, taken from
  // actual enrollments so the options match what the recipient rows carry.
  const admin = createAdminClient();
  const { data: enrollmentCohorts } = await admin
    .from("enrollments")
    .select("cohort:cohorts(name)");
  const cohortNames = Array.from(
    new Set(
      (enrollmentCohorts ?? [])
        .map((e: any) =>
          Array.isArray(e.cohort) ? e.cohort[0]?.name : e.cohort?.name,
        )
        .filter(Boolean) as string[],
    ),
  ).sort();

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Email blast</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Compose a branded email and send it to any set of students — or to
          their parents. Pick the group with the filters, then choose whether
          it reaches the student, the parent / guardian on their application,
          or both.
        </p>
      </div>
      <BlastForm cohortNames={cohortNames} siteUrl={env.siteUrl} />
    </div>
  );
}
