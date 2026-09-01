import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { passHolderUserIds } from "@/lib/founder-pass";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { TeamThread } from "@/components/team-thread";
import { FounderPassBadge } from "@/components/founder-pass-badge";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Team · Mentor" };

export default async function MentorTeamDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireMentor();
  const admin = createAdminClient();

  const { data: team } = await admin
    .from("teams")
    .select(
      "id, name, tagline, description, logo_url, logo_status, website_url, cohort:cohorts(name)",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!team) notFound();

  const [
    { data: members },
    { data: messages },
    { data: files },
    { data: pitch },
    passHolders,
  ] = await Promise.all([
    admin
      .from("team_members")
      .select("user_id, role, profile:profiles(full_name, email)")
      .eq("team_id", params.id),
    admin
      .from("team_messages")
      .select(
        "id, body, kind, created_at, author_id, author:profiles(full_name, email)",
      )
      .eq("team_id", params.id)
      .order("created_at", { ascending: true })
      .limit(200),
    admin
      .from("team_drive_files")
      .select("id, name, size_bytes, mime_type, created_at")
      .eq("team_id", params.id)
      .order("created_at", { ascending: false }),
    admin
      .from("pitch_submissions")
      .select("*")
      .eq("team_id", params.id)
      .maybeSingle(),
    passHolderUserIds(admin),
  ]);

  const cohort = Array.isArray(team.cohort) ? team.cohort[0] : team.cohort;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/mentor/teams"
        className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="h-3 w-3" /> Teams
      </Link>
      <header className="mt-3 flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-paper">
          {team.logo_url && team.logo_status === "approved" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={team.logo_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl font-bold text-phosphor-ink">
              {team.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink md:text-3xl">
            {team.name}
          </h1>
          {team.tagline && (
            <p className="text-sm text-ink-soft">{team.tagline}</p>
          )}
          <p className="mt-1 text-xs text-ink-faint">{cohort?.name ?? ""}</p>
        </div>
      </header>

      {team.description && (
        <Card className="mt-6">
          <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">About</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
            {team.description}
          </p>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Members</h2>
        <ul className="mt-3 divide-y divide-line">
          {(members ?? []).map((m: any) => {
            const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
            return (
              <li key={m.user_id} className="flex justify-between gap-3 py-2">
                <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {p?.full_name ?? p?.email}
                  {passHolders.has(m.user_id) && <FounderPassBadge />}
                </span>
                <span className="text-xs text-ink-faint">{m.role}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      {(pitch as any)?.submitted_at && (
        <Card className="mt-6">
          <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Demo Day submission</h2>
          <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
            Submitted on <LocalTime value={(pitch as any).submitted_at} />
          </div>
          {(pitch as any).video_url && (
            <a
              href={(pitch as any).video_url}
              className="mt-3 inline-block text-sm text-phosphor-ink hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Watch pitch video →
            </a>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">
          Drive ({(files ?? []).length})
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {(files ?? []).map((f: any) => (
            <li key={f.id} className="flex justify-between py-2 text-sm">
              <span className="truncate text-ink">{f.name}</span>
              <span className="text-xs text-ink-faint tabular-nums">
                <LocalTime value={f.created_at} mode="date" />
              </span>
            </li>
          ))}
          {(files ?? []).length === 0 && (
            <li className="py-3 text-sm text-ink-faint">Empty.</li>
          )}
        </ul>
      </Card>

      <div className="mt-6">
        <TeamThread
          teamId={params.id}
          messages={(messages ?? []) as any[]}
          passHolderIds={[...passHolders]}
        />
      </div>
    </div>
  );
}
