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
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-900">
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
            <span className="text-2xl font-bold text-spark">
              {team.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            {team.name}
          </h1>
          {team.tagline && (
            <p className="mt-1 text-sm text-white/55">{team.tagline}</p>
          )}
          <p className="mt-1 text-xs text-white/40">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            <span className="text-white/60">{team.my_role}</span>
          </p>
        </div>
      </header>

      {team.logo_status === "pending" && team.logo_url && (
        <div className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">
          Your logo is awaiting admin review. The placeholder shows on public
          pages until it's approved.
        </div>
      )}
      {team.logo_status === "rejected" && (
        <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
          Logo rejected
          {team.logo_rejected_reason ? `: ${team.logo_rejected_reason}` : "."}{" "}
          Upload a different one.
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/dashboard/team/offers">
          <button className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-white/75 transition hover:border-white/30 hover:text-white">
            <FileSignature className="h-3.5 w-3.5" /> SAFE offers
          </button>
        </Link>
        <Link href="/dashboard/team/pitch-coach">
          <button className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-white/75 transition hover:border-white/30 hover:text-white">
            <Sparkles className="h-3.5 w-3.5" /> Pitch coach
          </button>
        </Link>
      </div>

      <nav className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-white/10 bg-zinc-950/40 p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? "bg-spark/15 text-spark"
                  : "text-white/60 hover:text-white"
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
