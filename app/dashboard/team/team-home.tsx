"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Users,
  Settings,
  FolderOpen,
  Rocket,
  FileSignature,
  Sparkles,
  MessageSquare,
  Handshake,
  Bot,
} from "lucide-react";
import { TeamProfileTab } from "./team-profile-tab";
import { TeamMembersTab } from "./team-members-tab";
import { GoogleDrivePanel } from "@/components/team/google-drive-panel";
import { OlderUploads } from "@/components/team/older-uploads";
import type { OlderUploadsState, TeamDriveState } from "@/lib/team-drive";
import { TeamPitchTab } from "./team-pitch-tab";
import { isTeamToolVisible, type TeamToolHref } from "@/lib/student-nav";

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

type Tab = "overview" | "members" | "drive" | "pitch";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-wash px-3 py-1 text-xs font-medium text-ink-soft transition hover:border-ink/30 hover:text-ink";

export function TeamHome({
  initialTab,
  currentUserId,
  team,
  members,
  pendingInvites,
  drive,
  olderUploads,
  pitch,
  passHolderIds = [],
  showAi = false,
  preCohort = false,
}: {
  /** From ?tab=, so links can open a tab directly. */
  initialTab?: string;
  currentUserId: string;
  team: Team;
  members: any[];
  pendingInvites: any[];
  drive: TeamDriveState;
  olderUploads: OlderUploadsState;
  pitch: any;
  passHolderIds?: string[];
  /** The AI co-founder is open to this student (and configured). */
  showAi?: boolean;
  /** Before kickoff: only the tools middleware lets through get a chip. */
  preCohort?: boolean;
}) {
  const [picked, setTab] = useState<string | undefined>(initialTab);

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "overview", label: "Profile", icon: Settings },
    { id: "members", label: `Members (${members.length})`, icon: Users },
    { id: "drive", label: "Drive", icon: FolderOpen },
    { id: "pitch", label: "Demo Day", icon: Rocket },
  ];
  const tab: Tab = tabs.some((t) => t.id === picked) ? (picked as Tab) : "overview";
  const tool = (href: TeamToolHref) => isTeamToolVisible(href, { preCohort, ai: showAi });

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
          Logo pending review.
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
        {/* The team's private channel in batch0 Chat. Every team gets one
            when it's created, so the link is always there. */}
        <Link href={`/chat?team=${team.id}`} className={CHIP}>
          <MessageSquare className="h-3.5 w-3.5" /> Team chat
        </Link>
        {tool("/dashboard/intros") && (
          <Link href="/dashboard/intros" className={CHIP}>
            <Handshake className="h-3.5 w-3.5" /> Investor intros
          </Link>
        )}
        {tool("/dashboard/team/offers") && (
          <Link href="/dashboard/team/offers" className={CHIP}>
            <FileSignature className="h-3.5 w-3.5" /> SAFE offers
          </Link>
        )}
        {tool("/dashboard/team/pitch-coach") && (
          <Link href="/dashboard/team/pitch-coach" className={CHIP}>
            <Sparkles className="h-3.5 w-3.5" /> Pitch coach
          </Link>
        )}
        {tool("/dashboard/ai") && (
          <Link href="/dashboard/ai" className={CHIP}>
            <Bot className="h-3.5 w-3.5" /> AI co-founder
          </Link>
        )}
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
            passHolderIds={passHolderIds}
          />
        )}
        {tab === "drive" && (
          <div className="space-y-6">
            <GoogleDrivePanel teamId={team.id} drive={drive} canEdit />
            <OlderUploads {...olderUploads} />
          </div>
        )}
        {tab === "pitch" && (
          <TeamPitchTab teamId={team.id} pitch={pitch} />
        )}
      </div>
    </div>
  );
}
