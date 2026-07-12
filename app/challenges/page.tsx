import Link from "next/link";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { ChallengeWinners } from "@/components/challenge-winners";
import { getSiteConfig } from "@/lib/site-config";
import { getProfile, roleHome } from "@/lib/auth";
import { getActiveChallenge, getPublicWinners } from "@/lib/challenges";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = {
  title: "Weekly Challenges · Sparkline Youth",
  description:
    "Every week Sparkline posts a build challenge for high schoolers. Apply free — if we love your idea, we fund it.",
  alternates: { canonical: "/challenges" },
};

export default async function ChallengesIndexPage() {
  const [config, profile, active, winners] = await Promise.all([
    getSiteConfig(),
    getProfile(),
    getActiveChallenge(),
    getPublicWinners(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;

  return (
    <main className="min-h-screen bg-paper">
      <Navbar
        authedHome={authedHome}
        cohortLabel={config.derived.cohortLabel || "the next cohort"}
      />

      <section className="px-5 pb-8 pt-16 sm:px-6 md:pt-24">
        <div className="mx-auto max-w-[1100px]">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-spark-ink">
            Weekly Challenges
          </p>
          <h1 className="mt-3 max-w-3xl font-display text-[clamp(2rem,5vw,3.25rem)] font-bold leading-[1.05] tracking-[-0.025em] text-ink">
            Build something this week. We&apos;ll <span className="hl">fund it</span>.
          </h1>
          <p className="mt-5 max-w-2xl text-[1.0625rem] leading-[1.6] text-ink-soft">
            Every week we post a challenge. Apply for free — if we love what
            you&apos;re building, we back it with real money. No equity, no
            strings.
          </p>

          {active ? (
            <div className="mt-10 rounded-2xl border border-line bg-wash p-6 sm:p-8">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-spark-ink">
                This week
              </p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">
                {active.title}
              </h2>
              {active.description && (
                <p className="mt-3 max-w-2xl whitespace-pre-line text-[15px] leading-[1.6] text-ink-soft">
                  {active.description}
                </p>
              )}
              {(active.prizeLabel || active.closesAt) && (
                <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[13px]">
                  {active.prizeLabel && (
                    <span className="text-ink">
                      <span className="text-ink-faint">Prize · </span>
                      {active.prizeLabel}
                    </span>
                  )}
                  {active.closesAt && (
                    <span className="text-ink">
                      <span className="text-ink-faint">Closes · </span>
                      <LocalTime value={active.closesAt} mode="datetime-short" />
                    </span>
                  )}
                </div>
              )}
              <div className="mt-6">
                <a
                  href={`/challenges/${active.slug}`}
                  className="press inline-flex items-center justify-center gap-2 rounded-md bg-spark px-5 py-3 text-[15px] font-semibold text-on-spark shadow-cta hover:bg-spark-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                >
                  Apply to this challenge →
                </a>
              </div>
            </div>
          ) : (
            <div className="mt-10 rounded-2xl border border-line bg-wash p-6 text-[15px] text-ink-soft">
              No challenge is live right now — check back soon, or{" "}
              <Link href="/apply" className="link-ink">
                apply to the accelerator
              </Link>{" "}
              in the meantime.
            </div>
          )}
        </div>
      </section>

      <ChallengeWinners winners={winners} />
      <Footer config={config} />
    </main>
  );
}
