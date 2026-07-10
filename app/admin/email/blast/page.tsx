import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { BlastForm } from "./blast-form";

export const metadata = { title: "Email blast · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Blast sends go out via Resend's batch API (1 request / 100 emails),
// but give the action segment breathing room for big lists anyway.
export const maxDuration = 60;

export type BlastRecipient = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Best (furthest-along) application status, or null if never applied. */
  appStatus: string | null;
  /** Names of cohorts the user is enrolled in. */
  cohorts: string[];
};

// Application lifecycle rank — used to collapse a user's multiple
// applications down to their furthest-along status for filtering.
const STATUS_RANK: Record<string, number> = {
  enrolled: 5,
  paid: 4,
  accepted: 3,
  submitted: 2,
  rejected: 1,
  draft: 0,
};

export default async function AdminEmailBlastPage() {
  const admin = createAdminClient();
  const { data: profiles } = await admin
    .from("profiles")
    .select(
      "id, email, full_name, role, applications!applications_user_id_fkey(status), enrollments!enrollments_user_id_fkey(cohort:cohorts(name))",
    )
    .order("created_at", { ascending: false })
    .limit(5000);

  const recipients: BlastRecipient[] = (profiles ?? [])
    .filter((p: any) => p.email)
    .map((p: any) => {
      const statuses: string[] = (p.applications ?? []).map(
        (a: any) => a.status,
      );
      const appStatus =
        statuses.length > 0
          ? statuses.reduce((best, s) =>
              (STATUS_RANK[s] ?? -1) > (STATUS_RANK[best] ?? -1) ? s : best,
            )
          : null;
      const cohorts: string[] = (p.enrollments ?? [])
        .map((e: any) =>
          Array.isArray(e.cohort) ? e.cohort[0]?.name : e.cohort?.name,
        )
        .filter(Boolean);
      return {
        id: p.id,
        email: p.email,
        name: p.full_name || null,
        role: p.role,
        appStatus,
        cohorts,
      };
    });

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Email blast</h1>
        <p className="mt-1 text-sm text-white/55">
          Compose a branded email and send it to any set of students. Use{" "}
          <code className="rounded bg-white/10 px-1 font-mono text-spark">
            {"{{name}}"}
          </code>{" "}
          to personalize with each recipient&apos;s first name.
        </p>
      </div>
      <BlastForm recipients={recipients} siteUrl={env.siteUrl} />
    </div>
  );
}
