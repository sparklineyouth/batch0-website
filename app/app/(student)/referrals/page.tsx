import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudent } from "@/lib/auth";
import { computeReferralLeaderboard } from "@/lib/referrals";
import { getSiteConfig } from "@/lib/site-config";
import { env } from "@/lib/env";
import { CopyReferralLink } from "@/app/dashboard/referrals/copy-referral-link";
import {
  AppHeader,
  AppBody,
  Section,
  Stat,
  Row,
  Empty,
} from "@/components/app/frame";
import { StageBars, Ring } from "@/components/app/viz";

export const metadata = { title: "Referrals · batch0" };
export const dynamic = "force-dynamic";

/**
 * Referrals, without the leaderboard table.
 *
 * The desktop page renders a four-column `<table className="min-w-[480px]">`
 * inside a Card that clips overflow, so on a 390px phone the Applied and
 * Enrolled columns — the entire point of a leaderboard — are chopped off with
 * no scroller to reach them. It is also two taps from the More tab.
 *
 * The two things that page shows are different questions and get different
 * shapes here. "How am I doing" is a funnel: applied → accepted → enrolled is
 * a genuinely nested sequence (an enrolled referral was accepted, an accepted
 * one applied), so StageBars is honest about it and prints where people drop
 * off, which the three flat desktop tiles never did. "Where do I stand" is a
 * rank, so it is one number and a short list of rows — not a grid of counts
 * per person, which is the part that needed 480px.
 *
 * The leaderboard rows are rows, not a table: each is a person, they are read
 * top to bottom, and no cell needs to be compared across a column. That is the
 * line this app draws — data you aggregate becomes a graphic, and a list you
 * read stays a list.
 */

// First name plus last initial, matching the desktop page. Full recruiter
// names would read as competitive in a way this cohort has not opted into.
function maskName(full: string | null, fallback: string) {
  if (!full) return fallback;
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export default async function StudentAppReferrals() {
  const profile = await requireStudent();
  const admin = createAdminClient();

  // The admin client, for the same reason the desktop page uses it: a
  // student's own referral count spans OTHER users' applications, which the
  // own-or-staff RLS policy would hide from the scoped client. Only the status
  // column is selected — no PII crosses this boundary.
  //
  // The leaderboard chains off the config read rather than joining the wave
  // unconditionally: computeReferralLeaderboard throws on a query error, and
  // the paused card must not 500 because of a read it does not render.
  const configPromise = getSiteConfig();
  const [siteConfig, { data: ownReferred }, leaderboard] = await Promise.all([
    configPromise,
    admin
      .from("applications")
      .select("status")
      .eq("referral_code", profile.referral_code ?? "__none__"),
    configPromise.then((cfg) =>
      cfg.settings.referralsEnabled ? computeReferralLeaderboard(admin, 10) : [],
    ),
  ]);

  if (!siteConfig.settings.referralsEnabled) {
    return (
      <>
        <AppHeader title="Referrals" eyebrow="Paused" />
        <AppBody>
          <Empty>Referrals are paused for this program. Check back later.</Empty>
        </AppBody>
      </>
    );
  }

  const counts = (ownReferred ?? []).reduce(
    (acc, a) => {
      acc.applied++;
      const status = a.status as string;
      // Nested, not disjoint — which is what makes StageBars the right shape.
      // Someone enrolled was also accepted and also applied, so each stage
      // counts everyone at or past it. Feeding the funnel four current-status
      // buckets instead would invert it and clip the later bars at 100%.
      if (status === "accepted" || status === "paid" || status === "enrolled") {
        acc.accepted++;
      }
      if (status === "paid" || status === "enrolled") acc.enrolled++;
      return acc;
    },
    { applied: 0, accepted: 0, enrolled: 0 },
  );

  const myRankRaw = leaderboard.findIndex((r) => r.userId === profile.id);
  const myRank = myRankRaw >= 0 ? myRankRaw + 1 : null;
  const shareLink = `${env.siteUrl}/apply?ref=${profile.referral_code ?? ""}`;

  return (
    <>
      <AppHeader
        title="Refer friends"
        eyebrow={myRank != null ? `Ranked #${myRank}` : "Your link"}
      />
      <AppBody>
        <Section title="Your link">
          <div className="rounded-2xl border border-line bg-wash px-4 py-4">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Send people you respect. batch0 works best with founders who
              already know each other.
            </p>
            {/* The desktop copy control, reused rather than reimplemented — it
                is already a small client component whose only job is the
                clipboard, and a second copy would be a second thing to keep in
                sync. Its own layout is `flex-col md:flex-row`, so on a phone it
                stacks, which is what this column wants anyway. */}
            <CopyReferralLink
              href={shareLink}
              code={profile.referral_code ?? ""}
            />
          </div>
        </Section>

        <Section title="Where your referrals got to">
          {counts.applied === 0 ? (
            <Empty>
              Nobody has applied with your code yet. The link above is the whole
              job.
            </Empty>
          ) : (
            <div className="rounded-2xl border border-line bg-wash px-4 py-4">
              <StageBars
                label="Your referrals"
                stages={[
                  { key: "applied", label: "Applied", value: counts.applied },
                  { key: "accepted", label: "Accepted", value: counts.accepted },
                  { key: "enrolled", label: "Enrolled", value: counts.enrolled },
                ]}
              />
            </div>
          )}
        </Section>

        {leaderboard.length > 0 && (
          <Section title="Top recruiters">
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {leaderboard.map((r, i) => {
                const isMe = r.userId === profile.id;
                return (
                  <Row
                    key={r.referralCode}
                    label={isMe ? "You" : maskName(r.fullName, "Anonymous")}
                    // The rank is the leading element rather than a column,
                    // because it is the only field that has a fixed width and
                    // the only one worth scanning down.
                    leading={
                      <span
                        className={`w-6 shrink-0 text-center font-mono text-[13px] tabular-nums ${
                          isMe ? "text-phosphor-ink" : "text-ink-faint"
                        }`}
                      >
                        {i + 1}
                      </span>
                    }
                    // Two counts as one sentence, not two columns. The desktop
                    // table spent 200px of its 480 on right-aligned numeric
                    // columns that nobody compares row-to-row.
                    value={`${r.counts.applied} applied · ${r.counts.paidOrEnrolled} enrolled`}
                    muted={!isMe}
                  />
                );
              })}
            </div>
          </Section>
        )}

        {myRank == null && counts.applied > 0 && (
          <Section title="Your standing">
            <div className="rounded-2xl border border-line bg-wash px-4 py-4">
              <Stat
                label="Enrolled from your link"
                value={counts.enrolled}
                graphic={
                  <Ring
                    label="Referrals that enrolled"
                    value={counts.enrolled}
                    max={Math.max(1, counts.applied)}
                    unit=""
                    tone={counts.enrolled > 0 ? "good" : "default"}
                    caption={`${counts.enrolled} of ${counts.applied} who applied`}
                  />
                }
              />
            </div>
          </Section>
        )}
      </AppBody>
    </>
  );
}
