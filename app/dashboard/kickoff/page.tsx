import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { cohortHasStarted, todayISO } from "@/lib/pre-cohort";
import {
  daysLeftLabel,
  isExternalHref,
  readKickoffRow,
  resolveKickoff,
  type ResolvedKickoff,
} from "@/lib/kickoff";
import { ButtonLink } from "@/components/ui/button";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle,
  Clock,
  FolderArchive,
  MapPin,
  MessagesSquare,
  Pencil,
  PlayCircle,
  Rocket,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";

export const metadata = { title: "Kickoff · batch0" };

// The agenda and checklist are admin-authored rows with no icon field — an
// admin should be writing copy, not picking glyphs. Cycling a fixed set by
// position keeps a custom list looking as considered as the default one.
const AGENDA_ICONS = [PlayCircle, MessagesSquare, CalendarDays, CheckCircle];
const CHECKLIST_ICONS = [FolderArchive, MessagesSquare, Rocket, Settings];

type CohortRow = {
  id: string;
  name: string | null;
  starts_on: string | null;
  status: string | null;
};

const COHORT_SELECT = "id, name, starts_on, status";

/**
 * Kickoff — day one of the cohort, and afterwards the record of it.
 *
 * Gated on enrollment, not on the pre-cohort window. It used to redirect the
 * moment `starts_on` arrived, which had three consequences: a student who
 * bookmarked the page got bounced with no explanation, the welcome email's
 * kickoff link died on the day it mattered most, and the page's own "Kickoff
 * is today" branch was unreachable code. Now the page follows the cohort
 * through its whole life — counting down, then standing as the record of what
 * went live — and staff can open it to preview what they edit.
 */
export default async function KickoffPage() {
  await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");

  // Enrolled-only, like the pre-cohort resources. `enrolled` is true for staff
  // previewing the student view (lib/access.ts), so admins get in without a
  // second code path. A student whose payment has landed but whose enrollments
  // row hasn't been written yet counts too: /dashboard/enrolled shows them a
  // "See kickoff details" button the instant Stripe settles, and bouncing them
  // off it while a webhook catches up is exactly the moment that breeds
  // support email.
  const paidUp =
    access.applicationStatus === "paid" || access.applicationStatus === "enrolled";
  if (!access.enrolled && !paidUp) redirect("/dashboard");

  const admin = createAdminClient();
  let cohort: CohortRow | null = null;

  if (access.cohortId) {
    const { data } = await admin
      .from("cohorts")
      .select(COHORT_SELECT)
      .eq("id", access.cohortId)
      .maybeSingle();
    cohort = (data as CohortRow) ?? null;
  } else if (access.staff) {
    // Staff have no cohort of their own. Show them the one a student would be
    // looking at: the soonest upcoming cohort, or the newest if all have run.
    const { data } = await admin
      .from("cohorts")
      .select(COHORT_SELECT)
      .neq("status", "cancelled")
      .order("starts_on", { ascending: false, nullsFirst: false })
      .limit(12);
    const rows = (data as CohortRow[] | null) ?? [];
    const today = todayISO();
    const upcoming = rows
      .filter((c) => !cohortHasStarted(c, today))
      .sort((a, b) =>
        (a.starts_on ?? "9999-12-31") < (b.starts_on ?? "9999-12-31") ? -1 : 1,
      )[0];
    cohort = upcoming ?? rows[0] ?? null;
  }

  const kickoffRow = cohort ? await readKickoffRow(admin, cohort.id) : null;

  const today = todayISO();
  const k = resolveKickoff(
    kickoffRow,
    {
      name: cohort?.name ?? null,
      startsOn: cohort?.starts_on ?? null,
      status: cohort?.status ?? null,
      started: cohort ? cohortHasStarted(cohort, today) : false,
    },
    today,
  );

  const isPast = k.phase === "past";
  const isCancelled = k.phase === "cancelled";

  return (
    <div className="mx-auto max-w-4xl">
      {access.staff && (
        <StaffPreviewBar cohortId={cohort?.id ?? null} resolved={k} />
      )}

      <div className="border-b border-line pb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          {k.cohortLabel} · Kickoff
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-[-0.02em] text-ink md:text-5xl">
          {k.headline}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          {k.intro}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {k.phase === "today" && (
            <Pill icon={CalendarDays} accent>
              Kickoff is today
            </Pill>
          )}
          {k.daysLeft !== null && (
            <Pill icon={CalendarDays} accent>
              {daysLeftLabel(k.daysLeft)}
            </Pill>
          )}
          {isPast && k.dateLabel && (
            <Pill icon={CalendarDays}>{k.dateLabel}</Pill>
          )}
          {k.timeLabel && <Pill icon={Clock}>{k.timeLabel}</Pill>}
          {k.locationLabel && <Pill icon={MapPin}>{k.locationLabel}</Pill>}
        </div>

        {k.joinUrl && (
          <a
            href={k.joinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="press mt-5 inline-flex items-center gap-2 rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200"
          >
            <Video className="h-4 w-4" />
            {isPast ? "Open the kickoff link" : "Join the kickoff call"}
          </a>
        )}
      </div>

      {/* A cancelled cohort has no agenda and nothing to prepare for. Saying
          so and stopping is more honest than a checklist of busywork. */}
      {!isCancelled && (
        <section className="mt-10 grid gap-10 md:grid-cols-12">
          <div className="md:col-span-7">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
              {isPast ? "What went live at kickoff" : "What unlocks on kickoff day"}
            </h2>
            <div className="mt-4 border-t border-line">
              {k.agenda.map((item, i) => {
                const Icon = AGENDA_ICONS[i % AGENDA_ICONS.length];
                return (
                  <div
                    key={`${item.title}-${i}`}
                    className="flex items-start gap-4 border-b border-line py-5"
                  >
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium text-ink">
                        {item.title}
                      </p>
                      {item.body && (
                        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                          {item.body}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="md:col-span-5">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
              {isPast ? "Jump back in" : "Before kickoff"}
            </h2>
            <ul className="mt-4 space-y-2">
              {k.checklist.map((item, i) => (
                <li key={`${item.href}-${i}`}>
                  <ChecklistLink
                    href={item.href}
                    label={item.label}
                    icon={CHECKLIST_ICONS[i % CHECKLIST_ICONS.length]}
                  />
                </li>
              ))}
            </ul>

            <div className="mt-6 rounded-xl border border-line bg-wash p-4">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                <Sparkles className="h-3.5 w-3.5" />{" "}
                {isPast ? "Keep going" : "Head start"}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                {k.note}
              </p>
              <ButtonLink
                href={isPast ? "/dashboard/course" : "/dashboard/resources"}
                className="mt-4"
                size="sm"
              >
                {isPast ? "Open the course" : "Open pre-cohort resources"}
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
              </ButtonLink>
            </div>
          </aside>
        </section>
      )}
    </div>
  );
}

/**
 * Admins land here from the editor to check their copy. The bar says whose
 * kickoff they're looking at and links straight back to editing it — and when
 * there's no cohort at all it says so, rather than leaving them to wonder why
 * the page is showing stock copy.
 */
function StaffPreviewBar({
  cohortId,
  resolved,
}: {
  cohortId: string | null;
  resolved: ResolvedKickoff;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-phosphor/30 bg-phosphor/[0.08] px-4 py-3">
      <p className="text-sm text-ink-soft">
        <span className="font-medium text-ink">Staff preview.</span>{" "}
        {cohortId ? (
          <>
            Showing {resolved.cohortLabel}
            {resolved.usingDefaults
              ? " with the built-in defaults — nothing has been customised yet."
              : "."}
          </>
        ) : (
          <>No cohort exists yet, so this is the default page students see.</>
        )}
      </p>
      {cohortId && (
        <Link
          href={`/admin/cohorts/${cohortId}/kickoff`}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/30"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit this page
        </Link>
      )}
    </div>
  );
}

function Pill({
  icon: Icon,
  accent = false,
  children,
}: {
  icon: any;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={
        accent
          ? "inline-flex items-center gap-2 rounded-full border border-phosphor/30 bg-phosphor/[0.08] px-4 py-1.5 text-sm font-medium text-phosphor-ink"
          : "inline-flex items-center gap-2 rounded-full border border-line px-4 py-1.5 text-sm text-ink-soft"
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
    </span>
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
  const className =
    "press flex items-center gap-3 rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink-soft hover:border-ink/30 hover:bg-wash hover:text-ink";
  const inner = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1">{label}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
    </>
  );
  // An admin can point a checklist row at an external resource (a Notion doc,
  // a form). next/link would still render it, but a plain anchor is the honest
  // element for a cross-origin destination — and it gets the noopener rel.
  return isExternalHref(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}
