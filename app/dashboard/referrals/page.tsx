import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudent } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { computeReferralLeaderboard } from "@/lib/referrals";
import { getSiteConfig } from "@/lib/site-config";
import { env } from "@/lib/env";
import { CopyReferralLink } from "./copy-referral-link";
import { Crown, Award, TrendingUp } from "lucide-react";

export const metadata = { title: "Referrals · Sparkline Youth" };
export const dynamic = "force-dynamic";

// Show a small leaderboard with first-name-plus-initial only — full
// names of the recruiter would feel competitive in a bad way for a
// high-school cohort, and we don't have a real-name opt-in flow.
function maskName(full: string | null, fallback: string) {
  if (!full) return fallback;
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export default async function StudentReferralsPage() {
  const profile = await requireStudent();
  const admin = createAdminClient();
  const siteConfig = await getSiteConfig();

  if (!siteConfig.settings.referralsEnabled) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight">Referrals</h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Referrals are paused for this program. Check back later.
          </p>
        </Card>
      </div>
    );
  }

  // Use the admin client: a student's own referral count spans OTHER users'
  // applications, which RLS (own-or-staff) would hide from the scoped client.
  // Only non-PII status is selected.
  const { data: ownReferred } = await admin
    .from("applications")
    .select("status")
    .eq("referral_code", profile.referral_code ?? "__none__");

  const myCounts = (ownReferred ?? []).reduce(
    (acc: any, a: any) => {
      acc.applied++;
      if (a.status === "accepted") acc.accepted++;
      if (a.status === "paid" || a.status === "enrolled") acc.paid++;
      return acc;
    },
    { applied: 0, accepted: 0, paid: 0 },
  );

  const leaderboard = await computeReferralLeaderboard(admin, 10);
  const myRankRaw = leaderboard.findIndex((r) => r.userId === profile.id);
  const myRank = myRankRaw >= 0 ? myRankRaw + 1 : null;

  const shareLink = `${env.siteUrl}/apply?ref=${profile.referral_code ?? ""}`;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Refer friends</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Send people you respect. Sparkline Youth works best with founders who
        know each other already.
      </p>

      <Card className="mt-6">
        <p className="text-xs uppercase tracking-wider text-ink-faint">
          Your referral link
        </p>
        <CopyReferralLink href={shareLink} code={profile.referral_code ?? ""} />
      </Card>

      <section className="mt-6 grid gap-3 md:grid-cols-3">
        <Tile label="Applied with your code" value={myCounts.applied} icon={TrendingUp} />
        <Tile label="Accepted" value={myCounts.accepted} icon={Award} />
        <Tile label="Enrolled" value={myCounts.paid} icon={Crown} tone="spark" />
      </section>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="border-b border-line px-5 py-3 text-xs uppercase tracking-wider text-ink-faint">
          Top 10 recruiters
          {myRank != null && (
            <span className="ml-3 text-spark-ink normal-case tracking-normal">
              You're ranked #{myRank}
            </span>
          )}
        </div>
        {leaderboard.length === 0 ? (
          <p className="p-6 text-sm text-ink-soft">
            No referred applications yet. Be the first.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3 w-12">#</th>
                <th className="px-5 py-3">Recruiter</th>
                <th className="px-5 py-3 text-right">Applied</th>
                <th className="px-5 py-3 text-right">Enrolled</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((r, i) => {
                const isMe = r.userId === profile.id;
                const displayName = isMe
                  ? "You"
                  : maskName(r.fullName, "Anonymous");
                return (
                  <tr
                    key={r.referralCode}
                    className={`border-b border-line last:border-0 ${
                      isMe ? "bg-spark/5" : ""
                    }`}
                  >
                    <td className="px-5 py-3 tabular-nums text-ink-soft">
                      {i + 1}
                    </td>
                    <td className={`px-5 py-3 ${isMe ? "text-spark-ink" : "text-ink"}`}>
                      {displayName}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                      {r.counts.applied}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-spark-ink">
                      {r.counts.paidOrEnrolled || (
                        <span className="text-ink-faint">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: any;
  tone?: "default" | "spark";
}) {
  return (
    <div className="rounded-xl border border-line bg-wash px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        <Icon className={`h-3.5 w-3.5 ${tone === "spark" ? "text-spark-ink" : ""}`} />
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight ${
          tone === "spark" ? "text-spark-ink" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
