import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { fmtDateOnly, todayISO } from "@/lib/pre-cohort";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle,
  CreditCard,
  FolderArchive,
  MessagesSquare,
  PlayCircle,
  Settings,
  Sparkles,
} from "lucide-react";

export const metadata = { title: "Kickoff · batch0" };

export default async function KickoffPage() {
  await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");

  // Kickoff is a pre-cohort page. The middleware whitelists it during
  // lockdown, but anyone can type the URL — once the cohort has started
  // (or before an application passes review) there's nothing here, so
  // bounce home.
  if (!access.preCohort) redirect("/dashboard");

  const startDate = fmtDateOnly(access.cohortStartsOn);
  const daysLeft = access.cohortStartsOn
    ? Math.max(
        0,
        Math.round(
          (Date.parse(access.cohortStartsOn) - Date.parse(todayISO())) /
            86_400_000,
        ),
      )
    : null;
  // Accepted but seat not locked in yet — tuition leads the checklist.
  const needsTuition =
    !access.enrolled && access.applicationStatus === "accepted";

  return (
    <div className="mx-auto max-w-4xl">
      <div className="border-b border-line pb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          {access.cohortName ?? "Your cohort"} · Kickoff
        </p>
        <h1 className="mt-3 text-4xl md:text-5xl font-bold tracking-[-0.02em] text-ink">
          {startDate ?? "Date coming soon"}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] text-ink-soft leading-relaxed">
          Kickoff is day one of the cohort — the moment the full program
          unlocks. Until then this page and your pre-cohort resources are
          your launchpad.
        </p>
        {daysLeft !== null && (
          <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-phosphor/30 bg-phosphor/[0.08] px-4 py-1.5 text-sm font-medium text-phosphor-ink">
            <CalendarDays className="h-4 w-4" />
            {daysLeft === 0
              ? "Kickoff is today"
              : daysLeft === 1
                ? "1 day to go"
                : `${daysLeft} days to go`}
          </p>
        )}
      </div>

      <section className="mt-10 grid gap-10 md:grid-cols-12">
        <div className="md:col-span-7">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            What unlocks on kickoff day
          </h2>
          <div className="mt-4 border-t border-line">
            <InfoRow
              icon={PlayCircle}
              title="The course"
              body="Weekly modules and deliverables open, starting with week one. You'll ship something every week from day one."
            />
            <InfoRow
              icon={MessagesSquare}
              title="Your cohort"
              body="Community, announcements, and team pages go live — you'll meet the other founders you're building alongside."
            />
            <InfoRow
              icon={CalendarDays}
              title="Events & office hours"
              body="The full schedule appears: mentor office hours, workshops, and the road to Demo Day."
            />
            <InfoRow
              icon={CheckCircle}
              title="Weekly check-ins"
              body="Every week you report progress, blockers, and momentum. The first one lands in week one."
            />
          </div>
        </div>

        <aside className="md:col-span-5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Before kickoff
          </h2>
          <ul className="mt-4 space-y-2">
            {needsTuition && (
              <ChecklistLink
                href="/dashboard/application"
                icon={CreditCard}
                label="Pay tuition to lock in your seat"
              />
            )}
            <ChecklistLink
              href="/dashboard/resources"
              icon={FolderArchive}
              label="Work through the pre-cohort resources"
            />
            <ChecklistLink
              href="/dashboard/settings"
              icon={Settings}
              label="Complete your profile"
            />
          </ul>

          <div className="mt-6 rounded-xl border border-line bg-wash p-4">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
              <Sparkles className="h-3.5 w-3.5" /> Head start
            </p>
            <p className="mt-2 text-sm text-ink-soft leading-relaxed">
              The founders who get the most out of batch0 arrive with the
              pre-cohort readings done and a one-page sketch of their idea.
              Show up on {startDate ?? "day one"} ready to build.
            </p>
            <Link href="/dashboard/resources" className="mt-4 inline-block">
              <Button size="sm">
                Open pre-cohort resources
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </aside>
      </section>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  title,
  body,
}: {
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-4 border-b border-line py-5">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-ink">{title}</p>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function ChecklistLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: any;
  label: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="press flex items-center gap-3 rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink-soft hover:border-ink/30 hover:bg-wash hover:text-ink"
      >
        <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1">{label}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      </Link>
    </li>
  );
}
