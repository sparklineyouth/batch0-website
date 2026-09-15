import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { NewThreadForm } from "@/components/discussions/new-thread-form";
import { getCohortName } from "@/lib/discussions";

export const metadata = { title: "New discussion · batch0" };
export const dynamic = "force-dynamic";

export default async function NewDiscussionPage(props: {
  searchParams: Promise<{ to?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role);
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Discussions"
        applicationStatus={access.applicationStatus}
      />
    );
  }
  // Staff post to a cohort from the admin page, where they choose which.
  if (access.staff) redirect("/admin/discussions");

  const toTeam = searchParams.to === "team";
  const cohortName = await getCohortName(access.cohortId);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/dashboard/discussions"
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Discussions
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">
        {toTeam ? "Ask the team" : "New discussion"}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        {toTeam
          ? "Goes straight to the batch0 team. Nobody else can see it."
          : "Pick who it's for, then write."}
      </p>

      <div className="mt-8">
        <NewThreadForm
          initialVisibility={toTeam ? "admin" : "cohort"}
          cohortName={cohortName}
          canPostToCohort={!!access.cohortId}
        />
      </div>
    </div>
  );
}
