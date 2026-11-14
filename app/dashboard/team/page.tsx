import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { passHolderUserIds } from "@/lib/founder-pass";
import { Card } from "@/components/ui/card";
import { getMyTeam } from "@/lib/team";
import { CreateTeamForm } from "./create-team-form";
import { TeamHome } from "./team-home";
import { InvitesInbox } from "./invites-inbox";
import { getStudentAccess } from "@/lib/access";
import {
  applicableCriteria,
  buildScorecard,
  coerceAnchors,
  type CriterionRow,
} from "@/lib/demo-day-rubric";
import { LockedFeature } from "@/components/dashboard/locked-feature";

export const metadata = { title: "Team · batch0" };

export default async function TeamPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Team"
        applicationStatus={access.applicationStatus}
      />
    );
  }
  const admin = createAdminClient();

  const team = await getMyTeam(user.id);

  if (team) {
    const [
      { data: members },
      { data: invites },
      { data: files },
      { data: messages },
      { data: pitch },
      passHolders,
      { data: release },
    ] = await Promise.all([
      admin
        .from("team_members")
        .select("id, role, user_id, created_at, profile:profiles(full_name, email)")
        .eq("team_id", team.id)
        .order("created_at", { ascending: true }),
      admin
        .from("team_invites")
        .select(
          "id, status, message, created_at, invitee:profiles!team_invites_invitee_id_fkey(full_name, email)",
        )
        .eq("team_id", team.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      admin
        .from("team_drive_files")
        .select("id, name, size_bytes, mime_type, created_at, uploader_id")
        .eq("team_id", team.id)
        .order("created_at", { ascending: false }),
      admin
        .from("team_messages")
        .select(
          "id, body, kind, created_at, author_id, author:profiles(full_name, email, role)",
        )
        .eq("team_id", team.id)
        .order("created_at", { ascending: true })
        .limit(100),
      admin
        .from("pitch_submissions")
        .select("*")
        .eq("team_id", team.id)
        .maybeSingle(),
      passHolderUserIds(admin),
      admin
        .from("demo_day_feedback_releases")
        .select("released_at, show_on_dashboard, include_comments, note")
        .eq("team_id", team.id)
        .maybeSingle(),
    ]);

    // Judge scores reach this page only through a release an admin made.
    // Two gates, deliberately: RLS stops the raw rows being read by the
    // team's own session (migration 0075), and the card is only built here
    // when the release says the dashboard is one of the channels. Fetching
    // the scores *after* that check is what keeps an unreleased card out of
    // the page's props, where it would be readable in the HTML regardless of
    // what we chose to render.
    const feedback = await (async () => {
      const rel = release as any;
      if (!rel?.released_at || !rel.show_on_dashboard) return null;
      const [{ data: criteria }, { data: scores }] = await Promise.all([
        admin
          .from("demo_day_rubric_criteria")
          .select(
            "id, label, description, weight, max_score, cohort_id, anchors, position",
          )
          .order("position", { ascending: true }),
        admin
          .from("demo_day_scores")
          .select("criterion_id, score, comment, judge_id")
          .eq("team_id", team.id),
      ]);
      const rubric = applicableCriteria(
        ((criteria ?? []) as any[]).map((c) => ({
          ...c,
          weight: Number(c.weight),
          anchors: coerceAnchors(c.anchors),
        })) as CriterionRow[],
        (team as any).cohort_id ?? null,
      );
      const card = buildScorecard(rubric, (scores ?? []) as any[]);
      if (card.scoredCount === 0) return null;
      return {
        card: rel.include_comments
          ? card
          : // Notes the admin chose not to share never leave the server.
            { ...card, rows: card.rows.map((r) => ({ ...r, comments: [] })) },
        note: (rel.note as string | null) ?? null,
        releasedAt: rel.released_at as string,
        includeComments: !!rel.include_comments,
      };
    })();

    return (
      <TeamHome
        currentUserId={user.id}
        team={team}
        members={(members ?? []) as any[]}
        pendingInvites={(invites ?? []) as any[]}
        files={(files ?? []) as any[]}
        messages={(messages ?? []) as any[]}
        pitch={pitch as any}
        passHolderIds={[...passHolders]}
        feedback={feedback}
      />
    );
  }

  // No team yet — show inbox of invites + a "create a team" form.
  const { data: pendingForMe } = await admin
    .from("team_invites")
    .select(
      "id, status, message, created_at, team:teams(id, name, tagline), invited_by_profile:profiles!team_invites_invited_by_fkey(full_name, email)",
    )
    .eq("invitee_id", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Team</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Build your startup with up to 4 teammates from your cohort.
        {access.preCohort
          ? " You don't have to wait for kickoff — start a team now and invite anyone who's already enrolled."
          : ""}
      </p>

      {(pendingForMe?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Invites for you
          </h2>
          <InvitesInbox invites={pendingForMe as any[]} />
        </div>
      )}

      <Card className="mt-8">
        <h2 className="text-lg font-semibold">Start a new team</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Pick a working name — you can rename it any time.
        </p>
        <div className="mt-4">
          <CreateTeamForm />
        </div>
      </Card>
    </div>
  );
}
