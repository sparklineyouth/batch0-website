import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Mentor matchmaker · Admin" };

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "they", "their", "would",
  "could", "about", "where", "which", "while", "into", "your", "youre",
  "build", "building", "make", "thing", "people", "want", "wants",
  "going", "really",
]);

function tokens(t: string | null | undefined): Set<string> {
  if (!t) return new Set();
  return new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  );
}

function score(
  teamTokens: Set<string>,
  bio: string | null,
  tags: string[] | null,
): { score: number; reasons: string[] } {
  const bioTokens = tokens(bio);
  const reasons: string[] = [];
  let s = 0;
  // Bio overlap: each shared keyword = 1.0 point
  for (const t of teamTokens) {
    if (bioTokens.has(t)) {
      s += 1;
      if (reasons.length < 4) reasons.push(t);
    }
  }
  // Tag overlap: each shared tag = 2.0 points (more curated signal)
  for (const tag of tags ?? []) {
    const lc = tag.toLowerCase();
    if (teamTokens.has(lc) || [...teamTokens].some((t) => lc.includes(t))) {
      s += 2;
      reasons.push(`#${tag}`);
    }
  }
  return { score: s, reasons };
}

export default async function MentorMatchmakerPage({
  searchParams,
}: {
  searchParams: { team_id?: string };
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const teamId = searchParams.team_id ?? "";

  const [{ data: teams }, { data: mentors }] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, tagline, description, cohort:cohorts(name)")
      .order("name"),
    admin
      .from("profiles")
      .select("id, full_name, email, mentor_bio, mentor_tags")
      .in("role", ["mentor", "admin"]),
  ]);

  const team = (teams ?? []).find((t: any) => t.id === teamId) ?? null;
  let ranked: Array<{
    mentor: any;
    score: number;
    reasons: string[];
  }> = [];
  if (team) {
    const tt = new Set([
      ...tokens(team.name),
      ...tokens(team.tagline),
      ...tokens(team.description),
    ]);
    ranked = (mentors ?? []).map((m: any) => ({
      mentor: m,
      ...score(tt, m.mentor_bio, m.mentor_tags),
    }));
    ranked.sort((a, b) => b.score - a.score);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Mentor matchmaker</h1>
      <p className="mt-1 text-sm text-white/55">
        Pick a team to surface mentors whose bio + tags overlap with what the
        team is building. Use it as a starting point — final assignment
        still happens in <Link href="/admin/mentors" className="text-spark hover:underline">/admin/mentors</Link>.
      </p>

      <Card className="mt-6">
        <label htmlFor="match-team" className="text-xs uppercase tracking-wider text-white/55">
          Team
        </label>
        <form className="mt-2 flex gap-2" method="get">
          <select
            id="match-team"
            name="team_id"
            defaultValue={teamId}
            className="h-10 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white"
          >
            <option value="">— Pick team —</option>
            {(teams ?? []).map((t: any) => {
              const cohort = Array.isArray(t.cohort) ? t.cohort[0] : t.cohort;
              return (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {cohort?.name ? ` · ${cohort.name}` : ""}
                </option>
              );
            })}
          </select>
          <button
            type="submit"
            className="rounded-lg bg-spark px-4 text-sm font-semibold text-black transition active:scale-95"
          >
            Match
          </button>
        </form>
      </Card>

      {team && (
        <>
          <Card className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
              {team.name}
            </h2>
            {team.tagline && (
              <p className="mt-2 text-sm text-white/70">{team.tagline}</p>
            )}
            {team.description && (
              <p className="mt-3 line-clamp-4 text-sm text-white/55">
                {team.description}
              </p>
            )}
          </Card>

          <Card className="mt-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
              Top matches
            </h2>
            {ranked.filter((r) => r.score > 0).length === 0 ? (
              <p className="mt-3 text-sm text-white/50">
                No matches. Make sure mentors have filled in{" "}
                <code>mentor_bio</code> and <code>mentor_tags</code> on their
                profile.
              </p>
            ) : (
              <ol className="mt-3 space-y-3">
                {ranked
                  .filter((r) => r.score > 0)
                  .slice(0, 5)
                  .map(({ mentor, score, reasons }, i) => (
                    <li
                      key={mentor.id}
                      className="rounded-lg border border-white/10 bg-black/30 p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-white">
                            #{i + 1}. {mentor.full_name ?? mentor.email}
                          </p>
                          {mentor.mentor_bio && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-white/55">
                              {mentor.mentor_bio}
                            </p>
                          )}
                        </div>
                        <span className="text-xs font-semibold text-spark">
                          {score.toFixed(0)} pts
                        </span>
                      </div>
                      {reasons.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {reasons.map((r) => (
                            <span
                              key={r}
                              className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/65"
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
