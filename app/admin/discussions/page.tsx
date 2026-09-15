import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { ThreadList } from "@/components/discussions/thread-list";
import { TeamThreadForm } from "@/components/discussions/team-thread-form";
import { listThreadsForTeam } from "@/lib/discussions";

export const metadata = { title: "Discussions · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type View = "queue" | "questions" | "cohort";

/**
 * The team's inbox for student questions, and every cohort's discussion
 * board. Gated by `discussions.manage` (app/admin/layout.tsx + the route
 * rule in lib/permissions.ts).
 */
export default async function AdminDiscussionsPage(props: {
  searchParams: Promise<{ view?: string; cohort?: string }>;
}) {
  const searchParams = await props.searchParams;
  const view: View =
    searchParams.view === "questions"
      ? "questions"
      : searchParams.view === "cohort"
        ? "cohort"
        : "queue";
  const cohortFilter = searchParams.cohort || null;

  const admin = createAdminClient();
  const [{ data: cohorts }, queue, threads] = await Promise.all([
    admin.from("cohorts").select("id, name").order("starts_on", { ascending: false }),
    // The count for the tab badge, whatever view is open.
    listThreadsForTeam({ visibility: "admin", needsReply: true, limit: 500 }),
    view === "queue"
      ? Promise.resolve(null)
      : listThreadsForTeam({
          visibility: view === "questions" ? "admin" : "cohort",
          cohortId: cohortFilter,
        }),
  ]);

  const rows = view === "queue" ? queue : (threads ?? []);
  const cohortList = (cohorts ?? []) as { id: string; name: string }[];

  function href(v: View, cohort: string | null = cohortFilter) {
    const q = new URLSearchParams();
    if (v !== "queue") q.set("view", v);
    if (cohort && v === "cohort") q.set("cohort", cohort);
    const s = q.toString();
    return `/admin/discussions${s ? `?${s}` : ""}`;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Discussions
          </h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Private questions students send the team, and each cohort&apos;s
            discussion board. Replying to a question clears it from the queue
            and emails the student.
          </p>
        </div>
        <TeamThreadForm cohorts={cohortList} defaultCohortId={cohortFilter} />
      </div>

      <nav className="mt-8 flex flex-wrap gap-1 border-b border-line" aria-label="Views">
        <Tab href={href("queue")} active={view === "queue"}>
          Needs reply
          {queue.length > 0 && (
            <span className="ml-1.5 rounded-full bg-phosphor/15 px-1.5 text-[10px] text-phosphor-ink">
              {queue.length}
            </span>
          )}
        </Tab>
        <Tab href={href("questions")} active={view === "questions"}>
          All questions
        </Tab>
        <Tab href={href("cohort")} active={view === "cohort"}>
          Cohort boards
        </Tab>
      </nav>

      {view === "cohort" && cohortList.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-1.5 text-xs">
          <FilterChip href={href("cohort", null)} active={!cohortFilter}>
            All cohorts
          </FilterChip>
          {cohortList.map((c) => (
            <FilterChip key={c.id} href={href("cohort", c.id)} active={cohortFilter === c.id}>
              {c.name}
            </FilterChip>
          ))}
        </div>
      )}

      <section className="mt-5">
        {view !== "cohort" && (
          <p className="mb-4 flex items-start gap-2 text-xs text-ink-faint">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" />
            Private to the student and holders of discussions.manage. Don&apos;t
            quote these on a cohort board.
          </p>
        )}
        <ThreadList
          threads={rows}
          base="/admin/discussions"
          showCohort
          emptyText={
            view === "queue"
              ? "Inbox zero. Every question has a reply."
              : view === "questions"
                ? "No one has asked the team anything yet."
                : "No discussions on this board yet. Start one above — an intro thread is a good first post."
          }
        />
      </section>
    </div>
  );
}

function Tab({
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

function FilterChip({
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
      className={`press rounded-full border px-2.5 py-1 ${
        active
          ? "border-ink bg-ink text-paper"
          : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
