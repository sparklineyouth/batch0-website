import Link from "next/link";
import { MapPin, Trophy, Users, UserPlus } from "lucide-react";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ChallengeWinners } from "@/components/challenge-winners";
import { ChallengeCover } from "@/components/challenges/cover";
import { DateTile, PhasePill } from "@/components/challenges/time";
import { LocalTime } from "@/components/ui/local-time";
import { getPublicSiteConfig } from "@/lib/site-config";
import {
  getPublicChallenges,
  getPublicWinners,
  challengePhase,
  prizeHeadline,
  KIND_LABELS,
  type ChallengeListItem,
} from "@/lib/challenges";

export const metadata = {
  title: "Hackathons & Challenges · batch0",
  description:
    "Free hackathons, build challenges and giveaways for high schoolers. Register in one click, submit your project, win cash and real prizes.",
  alternates: { canonical: "/challenges" },
};

// Prerendered (scripts/verify-static.mjs asserts it). Admin edits and new
// registrations revalidate this path directly; the window is only the
// fallback for time passing — and the pills recompute in the browser anyway.
export const revalidate = 300;

export default async function ChallengesIndexPage() {
  const [config, all, winners] = await Promise.all([
    getPublicSiteConfig(),
    getPublicChallenges(),
    getPublicWinners(),
  ]);

  const now = Date.now();
  const withPhase = all.map((c) => ({ c, phase: challengePhase(c, now) }));
  const current = withPhase
    .filter(({ phase }) => phase === "live" || phase === "upcoming")
    .sort((a, b) => {
      // Live before upcoming; then the soonest deadline / start first.
      if (a.phase !== b.phase) return a.phase === "live" ? -1 : 1;
      const ka = a.c.closesAt ?? a.c.opensAt ?? "9999";
      const kb = b.c.closesAt ?? b.c.opensAt ?? "9999";
      return ka.localeCompare(kb);
    });
  const past = withPhase
    .filter(({ phase }) => phase === "judging" || phase === "ended")
    .sort((a, b) =>
      (b.c.closesAt ?? b.c.createdAt).localeCompare(a.c.closesAt ?? a.c.createdAt),
    );
  const [featured, ...rest] = current;

  return (
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={config.derived.cohortLabel || "the next cohort"} />
      <main id="main-content" tabIndex={-1}>
        <section className="px-5 pb-6 pt-14 sm:px-6 md:pt-20">
          <div className="mx-auto max-w-[1100px]">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
              Hackathons &amp; challenges
            </p>
            <h1 className="mt-3 max-w-3xl font-display text-[clamp(2.5rem,6vw,4rem)] leading-[1.02] text-ink">
              Build something. <span className="hl">Win real prizes.</span>
            </h1>
            <p className="mt-4 max-w-2xl text-[1.0625rem] leading-[1.6] text-ink-soft">
              Free for high schoolers. Register in one click, build on your own
              schedule, submit before the deadline. Cash, gear, and a real shot
              at getting noticed.
            </p>
          </div>
        </section>

        <section className="px-5 pb-8 sm:px-6">
          <div className="mx-auto max-w-[1100px]">
            {featured ? (
              <FeaturedCard item={featured.c} phase={featured.phase} />
            ) : (
              <div className="rounded-xl border border-line bg-wash p-6 text-[15px] text-ink-soft">
                Nothing is live right now — a new one drops soon. In the
                meantime,{" "}
                <Link href="/apply" className="link-ink">
                  apply to the accelerator
                </Link>
                .
              </div>
            )}
          </div>
        </section>

        {rest.length > 0 && (
          <ListSection title="Also open">
            {rest.map(({ c, phase }) => (
              <Row key={c.id} item={c} phase={phase} />
            ))}
          </ListSection>
        )}

        {past.length > 0 && (
          <ListSection title="Past">
            {past.map(({ c, phase }) => (
              <Row key={c.id} item={c} phase={phase} muted />
            ))}
          </ListSection>
        )}

        <ChallengeWinners winners={winners} />
      </main>
      <Footer config={config} />
    </div>
  );
}

function ListSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-5 py-8 sm:px-6">
      <div className="mx-auto max-w-[1100px]">
        <h2 className="mb-3 border-b border-line pb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
          {title}
        </h2>
        <ul className="divide-y divide-line">{children}</ul>
      </div>
    </section>
  );
}

function FeaturedCard({ item: c, phase }: { item: ChallengeListItem; phase: ReturnType<typeof challengePhase> }) {
  const headline = prizeHeadline(c);
  return (
    <Link
      href={`/challenges/${c.slug}`}
      className="group grid gap-6 rounded-2xl border border-line bg-paper p-4 hover:border-ink/25 sm:grid-cols-[240px_minmax(0,1fr)] sm:p-5 md:grid-cols-[300px_minmax(0,1fr)]"
    >
      <ChallengeCover
        title={c.title}
        kind={c.kind}
        imageUrl={c.coverImageUrl}
        theme={c.coverTheme}
        footer={headline}
      />
      <div className="flex min-w-0 flex-col py-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
            {KIND_LABELS[c.kind]}
          </span>
          <PhasePill challenge={c} initial={phase} withCountdown />
        </div>
        <h2 className="mt-3 font-display text-[clamp(2rem,4vw,2.75rem)] leading-[1.04] text-ink group-hover:underline group-hover:decoration-phosphor group-hover:decoration-2 group-hover:underline-offset-4">
          {c.title}
        </h2>
        {c.tagline && <p className="mt-2 text-[15px] text-ink-soft">{c.tagline}</p>}
        <ul className="mt-5 space-y-2.5 text-[14px] text-ink">
          <li className="flex items-center gap-3">
            <DateTile iso={c.closesAt ?? c.opensAt} className="!h-9 !w-9" />
            <span>
              {c.closesAt ? (
                <>
                  Due <LocalTime value={c.closesAt} mode="datetime-short" />
                </>
              ) : (
                "No deadline"
              )}
            </span>
          </li>
          {headline && (
            <li className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-phosphor text-on-phosphor">
                <Trophy className="h-4 w-4" />
              </span>
              {headline}
            </li>
          )}
          <li className="flex items-center gap-3 text-ink-soft">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-line">
              <MapPin className="h-4 w-4" />
            </span>
            {c.location}
            {c.registrationCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                · <Users className="h-3.5 w-3.5" /> {c.registrationCount} registered
              </span>
            )}
          </li>
          {c.referralsRequired > 0 && (
            <li className="flex items-center gap-3 text-ink-soft">
              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-line">
                <UserPlus className="h-4 w-4" />
              </span>
              Refer {c.referralsRequired} friend{c.referralsRequired === 1 ? "" : "s"} to submit
            </li>
          )}
        </ul>
        <span className="mt-6 inline-flex w-fit items-center rounded-md bg-phosphor px-5 py-3 text-[15px] font-semibold text-on-phosphor shadow-cta group-hover:bg-phosphor-200">
          {phase === "upcoming" ? "Register early →" : "Register & submit →"}
        </span>
      </div>
    </Link>
  );
}

function Row({
  item: c,
  phase,
  muted = false,
}: {
  item: ChallengeListItem;
  phase: ReturnType<typeof challengePhase>;
  muted?: boolean;
}) {
  const headline = prizeHeadline(c);
  const when = c.closesAt ?? c.opensAt;
  return (
    <li>
      <Link
        href={`/challenges/${c.slug}`}
        className="group grid grid-cols-[minmax(0,1fr)_72px] items-center gap-4 py-4 sm:grid-cols-[110px_minmax(0,1fr)_88px]"
      >
        <div className="hidden font-mono text-[12px] text-ink-faint sm:block">
          {when ? <LocalTime value={when} mode="date" /> : "—"}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PhasePill challenge={c} initial={phase} />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              {KIND_LABELS[c.kind]}
            </span>
          </div>
          <p className={`mt-1.5 truncate text-[16px] font-semibold group-hover:underline ${muted ? "text-ink-soft" : "text-ink"}`}>
            {c.title}
          </p>
          <p className="mt-0.5 truncate text-[13px] text-ink-faint">
            {/* The date column is desktop-only; phones get it inline. */}
            {when && (
              <span className="sm:hidden">
                {c.closesAt ? "Due " : "Opens "}
                <LocalTime value={when} mode="date" />
                {(headline || c.registrationCount > 0) && " · "}
              </span>
            )}
            {[
              headline,
              c.registrationCount > 0 ? `${c.registrationCount} registered` : null,
              c.winnersPublished ? "winners announced" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <ChallengeCover
          title={c.title}
          kind={c.kind}
          imageUrl={c.coverImageUrl}
          theme={c.coverTheme}
          size="sm"
          className={muted ? "opacity-80" : ""}
        />
      </Link>
    </li>
  );
}
