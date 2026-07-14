"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Users,
  Settings,
  FolderOpen,
  MessageSquare,
  Rocket,
  FileSignature,
  Sparkles,
} from "lucide-react";
import { TeamProfileTab } from "./team-profile-tab";
import { TeamMembersTab } from "./team-members-tab";
import { TeamDriveTab } from "./team-drive-tab";
import { TeamThreadTab } from "./team-thread-tab";
import { TeamPitchTab } from "./team-pitch-tab";

type Team = {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  logo_status: "pending" | "approved" | "rejected";
  logo_rejected_reason: string | null;
  website_url: string | null;
  is_public: boolean;
  creator_id: string | null;
  my_role: string;
};

type Tab = "overview" | "members" | "drive" | "thread" | "pitch";

export function TeamHome({
  currentUserId,
  team,
  members,
  pendingInvites,
  files,
  messages,
  pitch,
}: {
  currentUserId: string;
  team: Team;
  members: any[];
  pendingInvites: any[];
  files: any[];
  messages: any[];
  pitch: any;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "overview", label: "Profile", icon: Settings },
    { id: "members", label: `Members (${members.length})`, icon: Users },
    { id: "thread", label: "Thread", icon: MessageSquare },
    { id: "drive", label: `Drive (${files.length})`, icon: FolderOpen },
    { id: "pitch", label: "Demo Day", icon: Rocket },
  ];

  const showApprovedLogo =
    team.logo_status === "approved" && team.logo_url;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex items-start gap-5">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-wash">
          {showApprovedLogo ? (
            // Unoptimized so we don't need to pre-allowlist supabase storage
            // hosts at build time.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={team.logo_url ?? ""}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-2xl font-bold text-phosphor-ink">
              {team.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            {team.name}
          </h1>
          {team.tagline && (
            <p className="mt-1 text-sm text-ink-soft">{team.tagline}</p>
          )}
          <p className="mt-1 text-xs text-ink-faint">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            <span className="text-ink-soft">{team.my_role}</span>
          </p>
        </div>
      </header>

      {team.logo_status === "pending" && team.logo_url && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Your logo is awaiting admin review. The placeholder shows on public
          pages until it's approved.
        </div>
      )}
      {team.logo_status === "rejected" && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Logo rejected
          {team.logo_rejected_reason ? `: ${team.logo_rejected_reason}` : "."}{" "}
          Upload a different one.
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/dashboard/team/offers">
          <button className="inline-flex items-center gap-1.5 rounded-full border border-line bg-wash px-3 py-1 text-xs font-medium text-ink-soft transition hover:border-ink/30 hover:text-ink">
            <FileSignature className="h-3.5 w-3.5" /> SAFE offers
          </button>
        </Link>
        <Link href="/dashboard/team/pitch-coach">
          <button className="inline-flex items-center gap-1.5 rounded-full border border-line bg-wash px-3 py-1 text-xs font-medium text-ink-soft transition hover:border-ink/30 hover:text-ink">
            <Sparkles className="h-3.5 w-3.5" /> Pitch coach
          </button>
        </Link>
      </div>

      <nav className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-line bg-wash p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? "bg-phosphor/15 text-phosphor-ink"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-6">
        {tab === "overview" && (
          <TeamProfileTab team={team} />
        )}
        {tab === "members" && (
          <TeamMembersTab
            currentUserId={currentUserId}
            team={team}
            members={members}
            pendingInvites={pendingInvites}
          />
        )}
        {tab === "thread" && (
          <TeamThreadTab teamId={team.id} messages={messages} />
        )}
        {tab === "drive" && (
          <TeamDriveTab teamId={team.id} files={files} />
        )}
        {tab === "pitch" && (
          <TeamPitchTab teamId={team.id} pitch={pitch} />
        )}
      </div>
    </div>
  );
}
