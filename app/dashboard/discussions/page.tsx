import Link from "next/link";
import { MessageSquarePlus, ShieldCheck } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { ButtonLink } from "@/components/ui/button";
import { ThreadList } from "@/components/discussions/thread-list";
import {
  forStudent,
  getCohortName,
  getDiscussionViewer,
  listCohortThreads,
  listOwnQuestions,
  listThreadsForTeam,
} from "@/lib/discussions";

export const metadata = { title: "Discussions · batch0" };
export const dynamic = "force-dynamic";

type Tab = "cohort" | "questions";

export default async function DiscussionsPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile, caps } = await requireViewer();
  const access = await getStudentAccess(profile.role);

  // The sidebar hides this from an unenrolled applicant, but a typed URL
  // still lands here. Say what's true rather than show an empty board.
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Discussions"
        applicationStatus={access.applicationStatus}
      />
    );
  }

  const tab: Tab = searchParams.tab === "questions" ? "questions" : "cohort";
  const viewer = await getDiscussionViewer(profile.id, caps);

  // Staff previewing the student view have no cohort of their own, so the
  // board shows every cohort's discussions (they'd see them anyway from
  // /admin/discussions). Students see the cohorts they're enrolled in.
  const [cohortThreads, questions, cohortName] = await Promise.all([
    access.staff
      ? listThreadsForTeam({ visibility: "cohort" })
      : listCohortThreads(viewer.cohortIds),
    listOwnQuestions(profile.id),
    getCohortName(access.cohortId),
  ]);

  const awaiting = questions.filter((q) => q.status === "open" && !q.needsReply).length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Discussions</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Talk to your cohort, or ask the batch0 team something privately —
            a question to the team is visible only to you and us.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!access.staff && (
            <ButtonLink href="/dashboard/discussions/new?to=team" variant="secondary" size="sm">
              <ShieldCheck className="h-3.5 w-3.5" />
              Ask the team
            </ButtonLink>
          )}
          {!access.staff && access.cohortId && (
            <ButtonLink href="/dashboard/discussions/new" size="sm">
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New discussion
            </ButtonLink>
          )}
          {access.staff && (
            <ButtonLink href="/admin/discussions" size="sm">
              Team view →
            </ButtonLink>
          )}
        </div>
      </div>

      <nav className="mt-8 flex gap-1 border-b border-line" aria-label="Discussion views">
        <TabLink href="/dashboard/discussions" active={tab === "cohort"}>
          {access.staff ? "All cohorts" : cohortName ?? "My cohort"}
        </TabLink>
        <TabLink href="/dashboard/discussions?tab=questions" active={tab === "questions"}>
          My questions to the team
          {awaiting > 0 && (
            <span className="ml-1.5 rounded-full bg-phosphor/15 px-1.5 text-[10px] text-phosphor-ink">
              {awaiting} answered
            </span>
          )}
        </TabLink>
      </nav>

      <section className="mt-5">
        {tab === "cohort" ? (
          <ThreadList
            threads={cohortThreads.map(forStudent)}
            base="/dashboard/discussions"
            showCohort={access.staff}
            emptyText="Nothing on the board yet. Start the first thread — an intro, a question, something you're stuck on."
          />
        ) : (
          <>
            <p className="mb-4 flex items-start gap-2 rounded-md border border-line bg-wash px-4 py-3 text-xs text-ink-soft">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" />
              These threads are private. Only you and the batch0 team can see
              them — never anyone else in the cohort.
            </p>
            <ThreadList
              threads={questions.map(forStudent)}
              base="/dashboard/discussions"
              emptyText="You haven't asked the team anything yet. Anything about the program, your team, or logistics — ask here and we'll reply in the thread."
            />
          </>
        )}
      </section>
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={`-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm ${
        active
          ? "border-phosphor font-medium text-ink"
          : "border-transparent text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
