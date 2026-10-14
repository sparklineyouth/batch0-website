import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { passHolderUserIds } from "@/lib/founder-pass";
import { Card } from "@/components/ui/card";
import { getMyTeam } from "@/lib/team";
import { CreateTeamForm } from "./create-team-form";
import { TeamHome } from "./team-home";
import { InvitesInbox } from "./invites-inbox";
import { getStudentAccess, aiAccessFrom } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { isDiscordEnabled } from "@/lib/discord";
import { discordChannelUrl } from "@/lib/discord-links";
import { env } from "@/lib/env";
import { loadOlderUploads, loadTeamDrive } from "@/lib/team-drive";
import { OlderUploads } from "@/components/team/older-uploads";

export const metadata = { title: "Team · batch0" };

export default async function TeamPage(props: {
  searchParams: Promise<{ tab?: string; older?: string }>;
}) {
  const { tab, older } = await props.searchParams;
  // Set by the older-uploads download route when a file can't be served.
  const olderUnavailable = older === "unavailable";
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
  // The AI co-founder lives here, with the other startup tools.
  const showAi = aiAccessFrom(access) && !!env.anthropicApiKey;

  const team = await getMyTeam(user.id);

  if (team) {
    const drivePromise = loadTeamDrive(admin, team.id);
    const olderUploadsPromise = loadOlderUploads(admin, { userId: user.id, teamId: team.id });
    const [
      { data: members },
      { data: invites },
      { data: pitch },
      passHolders,
      discordEnabled,
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
        .from("pitch_submissions")
        .select("*")
        .eq("team_id", team.id)
        .maybeSingle(),
      passHolderUserIds(admin),
      isDiscordEnabled(),
    ]);
    const [drive, olderUploads] = await Promise.all([drivePromise, olderUploadsPromise]);

    return (
      <TeamHome
        // Keyed on ?tab= so a link to another tab (e.g. /dashboard/files →
        // ?tab=drive) switches tabs even when the page is already open.
        key={tab ?? ""}
        initialTab={tab}
        currentUserId={user.id}
        team={team}
        members={(members ?? []) as any[]}
        pendingInvites={(invites ?? []) as any[]}
        drive={drive}
        olderUploads={{ ...olderUploads, unavailable: olderUnavailable }}
        pitch={pitch as any}
        passHolderIds={[...passHolders]}
        discordChannelUrl={
          discordEnabled
            ? discordChannelUrl(env.discordGuildId, team.discord_text_channel_id)
            : null
        }
        showAi={showAi}
        preCohort={access.preCohort}
      />
    );
  }

  // No team yet — show inbox of invites + a "create a team" form.
  const olderUploads = await loadOlderUploads(admin, { userId: user.id, teamId: null });
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
        Up to 4 teammates from your cohort.
        {showAi && (
          <>
            {" "}
            <Link href="/dashboard/ai" className="link-ink">
              AI co-founder →
            </Link>
          </>
        )}
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
          A working name is fine.
        </p>
        <div className="mt-4">
          <CreateTeamForm />
        </div>
      </Card>

      <OlderUploads className="mt-8" {...olderUploads} unavailable={olderUnavailable} />
    </div>
  );
}
