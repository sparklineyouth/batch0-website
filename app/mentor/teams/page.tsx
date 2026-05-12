import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Teams · Mentor" };

export default async function MentorTeamsPage() {
  await requireMentor();
  const admin = createAdminClient();

  const { data: teams } = await admin
    .from("teams")
    .select(
      "id, name, tagline, slug, logo_url, logo_status, cohort:cohorts(name), team_members(count)",
    )
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Teams</h1>
      <p className="mt-1 text-sm text-white/55">
        Click a team to view their progress, send feedback, or browse their
        drive.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {(teams ?? []).map((t: any) => {
          const cohort = Array.isArray(t.cohort) ? t.cohort[0] : t.cohort;
          const count = Array.isArray(t.team_members)
            ? t.team_members[0]?.count
            : t.team_members?.count;
          return (
            <Link key={t.id} href={`/mentor/teams/${t.id}`}>
              <Card className="transition hover:border-white/20">
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
                    {t.logo_url && t.logo_status === "approved" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={t.logo_url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-lg font-bold text-spark">
                        {t.name?.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold text-white">
                      {t.name}
                    </h3>
                    <p className="text-xs text-white/40">
                      {cohort?.name ?? ""} · {count ?? 0} member
                      {count === 1 ? "" : "s"}
                    </p>
                    {t.tagline && (
                      <p className="mt-2 line-clamp-2 text-sm text-white/55">
                        {t.tagline}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
        {(teams?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-white/50">No teams yet.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
