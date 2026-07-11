import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { getMyTeam } from "@/lib/team";
import { CreateTeamForm } from "./create-team-form";
import { TeamHome } from "./team-home";
import { InvitesInbox } from "./invites-inbox";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";

export const metadata = { title: "Team · Sparkline Youth" };

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
          "id, body, kind, created_at, author:profiles(full_name, email, role)",
        )
        .eq("team_id", team.id)
        .order("created_at", { ascending: true })
        .limit(100),
      admin
        .from("pitch_submissions")
        .select("*")
        .eq("team_id", team.id)
        .maybeSingle(),
    ]);

    return (
      <TeamHome
        currentUserId={user.id}
        team={team}
        members={(members ?? []) as any[]}
        pendingInvites={(invites ?? []) as any[]}
        files={(files ?? []) as any[]}
        messages={(messages ?? []) as any[]}
        pitch={pitch as any}
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
      <p className="mt-1 text-sm text-white/55">
        Build your startup with up to 4 teammates from your cohort.
      </p>

      {(pendingForMe?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/60">
            Invites for you
          </h2>
          <InvitesInbox invites={pendingForMe as any[]} />
        </div>
      )}

      <Card className="mt-8">
        <h2 className="text-lg font-semibold">Start a new team</h2>
        <p className="mt-1 text-sm text-white/55">
          Pick a working name — you can rename it any time.
        </p>
        <div className="mt-4">
          <CreateTeamForm />
        </div>
      </Card>
    </div>
  );
}
