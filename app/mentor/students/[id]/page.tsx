import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMentor } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ArrowLeft, BookOpen, CheckCircle, MessageSquare, Rocket, FolderOpen } from "lucide-react";
import { FileFeedbackPanel } from "./file-feedback-panel";

export const metadata = { title: "Student · Mentor" };

function pct(num: number, denom: number) {
  if (!denom) return 0;
  return Math.round((num * 100) / denom);
}

export default async function StudentProgressPage({
  params,
}: {
  params: { id: string };
}) {
  await requireMentor();
  const admin = createAdminClient();

  const studentId = params.id;

  const [
    { data: profile },
    { data: enrollment },
    { data: app },
    { data: progress },
    { data: lessons },
    { data: checkins },
    { data: aiConvos },
    { data: team },
    { data: files },
  ] = await Promise.all([
    admin.from("profiles").select("*").eq("id", studentId).maybeSingle(),
    admin
      .from("enrollments")
      .select("*, cohort:cohorts(name)")
      .eq("user_id", studentId)
      .maybeSingle(),
    admin
      .from("applications")
      .select("*")
      .eq("user_id", studentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("lesson_progress").select("*").eq("user_id", studentId),
    admin.from("lessons").select("id"),
    admin
      .from("student_checkins")
      .select("*")
      .eq("user_id", studentId)
      .order("week_start", { ascending: false })
      .limit(8),
    admin
      .from("ai_conversations")
      .select("id, created_at, title")
      .eq("user_id", studentId)
      .order("created_at", { ascending: false })
      .limit(5),
    admin
      .from("team_members")
      .select("team:teams(id, name, slug)")
      .eq("user_id", studentId)
      .limit(1)
      .maybeSingle(),
    admin
      .from("student_files")
      .select("id, name, size_bytes, mime_type, created_at")
      .eq("user_id", studentId)
      .order("created_at", { ascending: false }),
  ]);

  if (!profile) notFound();

  const completedLessons = (progress ?? []).filter(
    (p: any) => p.completed_at,
  ).length;
  const totalLessons = (lessons ?? []).length || 0;

  const recentCheckins = (checkins ?? []) as any[];
  const streak = recentCheckins.length;
  const t = team?.team
    ? Array.isArray(team.team)
      ? team.team[0]
      : team.team
    : null;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/mentor/students"
        className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="h-3 w-3" /> Students
      </Link>
      <h1 className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink md:text-3xl">
        {profile.full_name ?? profile.email}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        {profile.email}
        {enrollment?.cohort?.name && <> · {(enrollment as any).cohort.name}</>}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat
          icon={BookOpen}
          label="Lessons complete"
          value={`${completedLessons}${totalLessons ? ` / ${totalLessons}` : ""}`}
          accent={pct(completedLessons, totalLessons)}
        />
        <Stat
          icon={FolderOpen}
          label="Files uploaded"
          value={`${(files ?? []).length}`}
        />
        <Stat
          icon={CheckCircle}
          label="Check-in streak"
          value={`${streak} week${streak === 1 ? "" : "s"}`}
        />
      </div>

      {t && (
        <Card className="mt-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-ink-faint">
                Team
              </h2>
              <p className="mt-1 font-display text-lg font-semibold tracking-[-0.02em] text-ink">{t.name}</p>
            </div>
            <Link
              href={`/mentor/teams/${t.id}`}
              className="text-sm text-spark-ink hover:underline"
            >
              Open team →
            </Link>
          </div>
        </Card>
      )}

      <div className="mt-6">
        <FileFeedbackPanel
          studentId={studentId}
          files={(files ?? []) as any[]}
        />
      </div>

      <Card className="mt-6">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Recent check-ins</h2>
        {recentCheckins.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">None yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {recentCheckins.slice(0, 4).map((c: any) => (
              <li
                key={c.id}
                className="rounded-lg border border-line bg-paper p-3"
              >
                <div className="font-mono text-xs uppercase tracking-wider text-ink-faint">
                  Week of {c.week_start}
                </div>
                {c.accomplished && (
                  <p className="mt-1 line-clamp-3 text-sm text-ink-soft">
                    <span className="text-ink-faint">Did:</span>{" "}
                    {c.accomplished}
                  </p>
                )}
                {c.blockers && (
                  <p className="mt-1 line-clamp-2 text-sm text-amber-700 dark:text-amber-300">
                    <span className="text-ink-faint">Blockers:</span>{" "}
                    {c.blockers}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold tracking-[-0.02em] text-ink">
          <MessageSquare className="h-4 w-4" /> AI usage
        </h2>
        {(aiConvos ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">No AI conversations.</p>
        ) : (
          <ul className="mt-3 space-y-1 text-sm text-ink-soft">
            {(aiConvos ?? []).map((c: any) => (
              <li key={c.id}>
                {c.title ?? "Untitled conversation"}{" "}
                <span className="text-xs text-ink-faint">
                  · <LocalTime value={c.created_at} mode="date" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
  extra,
}: {
  icon: any;
  label: string;
  value: string;
  accent?: number;
  extra?: string;
}) {
  return (
    <Card className="!p-4">
      <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-faint">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-2 font-display text-2xl font-bold tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </div>
      {extra && <p className="mt-1 text-xs text-ink-faint">{extra}</p>}
      {typeof accent === "number" && accent > 0 && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-spark"
            style={{ width: `${Math.min(100, accent)}%` }}
          />
        </div>
      )}
    </Card>
  );
}
