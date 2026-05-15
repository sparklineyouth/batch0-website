import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { PitchCoachForm } from "./pitch-coach-form";

export const metadata = { title: "Pitch coach · Team" };

export default async function PitchCoachPage() {
  const user = await requireUser();
  const admin = createAdminClient();
  const { data: memberships } = await admin
    .from("team_members")
    .select("team_id, team:teams(id, name)")
    .eq("user_id", user.id);
  if (!memberships || memberships.length === 0) redirect("/dashboard/team");
  // Single-team MVP — pick the first.
  const m = memberships[0] as any;
  const team = Array.isArray(m.team) ? m.team[0] : m.team;
  const teamId = m.team_id;

  const { data: history } = await admin
    .from("pitch_coach_feedback")
    .select(
      "id, source_kind, source, scores, overall_score, summary, strengths, improvements, created_at",
    )
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/team"
        className="text-sm text-white/55 hover:text-white"
      >
        ← Team
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Pitch coach</h1>
      <p className="mt-1 text-sm text-white/55">
        Paste a deck link, Loom URL, or your pitch transcript. The coach scores
        you against the Demo Day rubric and tells you exactly what to fix
        before pitching live.
      </p>

      <Card className="mt-6">
        <PitchCoachForm teamId={teamId} />
      </Card>

      {(history?.length ?? 0) > 0 && (
        <div className="mt-8 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            History
          </h2>
          {(history ?? []).map((h: any) => (
            <Card key={h.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs uppercase tracking-wider text-white/45">
                  {h.source_kind.replace("_", " ")}
                </p>
                <p className="text-xs text-white/45">
                  <LocalTime value={h.created_at} />
                </p>
              </div>
              {typeof h.overall_score === "number" && (
                <p className="mt-1 text-2xl font-bold tracking-tight text-spark">
                  {Number(h.overall_score).toFixed(1)}
                  <span className="ml-1 text-xs font-normal text-white/45">
                    / 100
                  </span>
                </p>
              )}
              {h.scores && Object.keys(h.scores).length > 0 && (
                <ul className="mt-3 space-y-2 text-xs">
                  {Object.entries(h.scores as Record<string, any>).map(
                    ([label, val]: any) => (
                      <li
                        key={label}
                        className="rounded-lg border border-white/10 bg-black/30 p-2"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="font-medium text-white">
                            {label}
                          </span>
                          <span className="text-spark">
                            {val?.score ?? "—"}
                          </span>
                        </div>
                        {val?.why && (
                          <p className="mt-1 text-white/65">{val.why}</p>
                        )}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {h.summary && (
                <p className="mt-3 whitespace-pre-wrap text-sm text-white/85">
                  {h.summary}
                </p>
              )}
              {h.strengths && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs uppercase tracking-wider text-emerald-300">
                    Strengths
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-white/80">
                    {h.strengths}
                  </p>
                </details>
              )}
              {h.improvements && (
                <details className="mt-3" open>
                  <summary className="cursor-pointer text-xs uppercase tracking-wider text-amber-200">
                    Fix these
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-white/85">
                    {h.improvements}
                  </p>
                </details>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
