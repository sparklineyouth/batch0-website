import Link from "next/link";
import { ArrowRight, Handshake } from "lucide-react";
import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "Investor intros · SparkLine Youth" };

const PRETTY_STATUS: Record<string, string> = {
  requested: "Requested",
  intro_made: "Intro made",
  meeting_held: "Met",
  committed: "Committed",
  wired: "Wired",
  passed: "Passed",
};

const STATUS_TONE: Record<string, string> = {
  requested: "border-white/15 bg-white/[0.04] text-white/70",
  intro_made: "border-blue-400/30 bg-blue-400/10 text-blue-200",
  meeting_held: "border-blue-400/30 bg-blue-400/10 text-blue-200",
  committed: "border-spark/40 bg-spark/10 text-spark",
  wired: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  passed: "border-white/10 bg-white/[0.03] text-white/55",
};

export default async function StudentIntrosPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Investor intros"
        applicationStatus={access.applicationStatus}
      />
    );
  }

  // Admin client because intro_requests RLS only opens to admins,
  // investors, and (post-migration 0019) team members. We re-query the
  // user's team membership server-side as the authority for what to
  // show — RLS is the backstop, the admin client is the convenience.
  const admin = createAdminClient();
  const { data: memberships } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", user.id);
  const teamIds = (memberships ?? [])
    .map((m: any) => m.team_id as string)
    .filter(Boolean);

  if (teamIds.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
          Investor intros
        </p>
        <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-[-0.02em]">
          No team yet.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-white/75">
          Intros are tied to your team. Start or join one to see warm
          intros from interested investors here.
        </p>
        <Link
          href="/dashboard/team"
          className="press mt-7 inline-flex items-center gap-2 rounded-md bg-spark px-4 py-2.5 text-sm font-semibold text-black hover:bg-spark-200"
        >
          Open team
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  const { data: intros } = await admin
    .from("intro_requests")
    .select(
      "id, status, message, created_at, updated_at, " +
        "investor:profiles!intro_requests_investor_id_fkey(full_name, email), " +
        "team:teams(name)",
    )
    .in("team_id", teamIds)
    .order("updated_at", { ascending: false });

  const rows = (intros ?? []) as any[];
  const wired = rows.filter((i) => i.status === "wired");
  const active = rows.filter(
    (i) => i.status !== "wired" && i.status !== "passed",
  );
  const closed = rows.filter((i) => i.status === "passed");

  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
        Investor intros
      </p>
      <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-[-0.02em]">
        Investors interested in your team.
      </h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/75">
        Investors who request an intro show up here. Admins move them
        through the funnel — you'll see status changes the moment they
        happen.
      </p>

      {rows.length === 0 && (
        <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/10">
            <Handshake className="h-4 w-4 text-white/40" />
          </div>
          <p className="mt-4 text-sm text-white/75">
            No intros yet. Investors browse teams after Demo Day.
          </p>
        </div>
      )}

      {wired.length > 0 && (
        <Section title="Wired" subtitle="Funds received">
          {wired.map((i) => (
            <IntroRow key={i.id} intro={i} />
          ))}
        </Section>
      )}

      {active.length > 0 && (
        <Section title="In flight" subtitle="Open or in-progress">
          {active.map((i) => (
            <IntroRow key={i.id} intro={i} />
          ))}
        </Section>
      )}

      {closed.length > 0 && (
        <Section title="Passed" subtitle="Closed for now">
          {closed.map((i) => (
            <IntroRow key={i.id} intro={i} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">
          {title}
        </h2>
        <p className="text-xs text-white/45">{subtitle}</p>
      </div>
      <ul className="divide-y divide-white/10 border-y border-white/10">
        {children}
      </ul>
    </section>
  );
}

function IntroRow({ intro }: { intro: any }) {
  const investor = Array.isArray(intro.investor)
    ? intro.investor[0]
    : intro.investor;
  const team = Array.isArray(intro.team) ? intro.team[0] : intro.team;
  const name =
    investor?.full_name ?? investor?.email ?? "An interested investor";
  const tone = STATUS_TONE[intro.status] ?? STATUS_TONE.requested;
  return (
    <li className="flex items-start gap-4 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-white">{name}</p>
        {team?.name && (
          <p className="mt-0.5 text-xs text-white/55">
            For team {team.name}
          </p>
        )}
        {intro.message && (
          <p className="mt-2 text-sm text-white/75 leading-relaxed">
            "{intro.message}"
          </p>
        )}
        <p className="mt-2 text-[11px] text-white/45">
          Last update <LocalTime value={intro.updated_at} mode="date" />
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${tone}`}
      >
        {PRETTY_STATUS[intro.status] ?? intro.status}
      </span>
    </li>
  );
}
