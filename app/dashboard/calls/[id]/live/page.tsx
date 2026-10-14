import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getInvite } from "@/lib/calls";
import {
  callRoomAccess,
  callStaffIds,
  CALL_STAFF_OPENS_MINUTES_BEFORE,
  inviteEndsAt,
  isOnCall,
  isStaffOnCall,
  JOIN_OPENS_MINUTES_BEFORE,
  joinNames,
  staffNames,
} from "@/lib/live";
import { hostCallsHref } from "@/lib/call-lifecycle";
import { BuiltinCallRoom } from "./builtin-room";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = {
  title: "1:1 call · batch0",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CallLivePage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  await requireUser();
  const viewer = await getViewer();
  if (!viewer) notFound();
  const profile = viewer.profile;

  const invite = await getInvite(params.id);
  if (!invite) notFound();

  // A 1:1 is private to the people on it: the student, the host, and any
  // co-hosts (migration 0092). Not "can you see this page" but "are you on
  // the call" — an admin browsing the safeguarding list can read that a call
  // happened without being able to walk into it.
  if (!isOnCall(invite, profile.id)) notFound();
  const isStaff = isStaffOnCall(invite, profile.id);

  // "Back" is this person's own calls list. For the student that is
  // /dashboard/calls; for a mentor it is /mentor/calls — sending a host (or a
  // co-host) to the student inbox showed them an empty page after every call.
  const backHref = isStaff
    ? hostCallsHref({
        superAdmin: viewer.caps.superAdmin,
        mentorPanel: can(viewer.caps, "mentor.panel"),
        investorPanel: can(viewer.caps, "investor.panel"),
        canInvite: can(viewer.caps, "calls.invite"),
      })
    : "/dashboard/calls";

  // The same rule joinRoom applies (callRoomAccess in lib/live.ts): an
  // unanswered invite is joinable like an accepted one, the staff side may
  // come in an hour early, and the room stays open until End call or the
  // hard stop.
  const access = callRoomAccess({ ...invite, isStaff });
  if (access !== "open" && access !== "live" && access !== "early") {
    const why: Record<string, string> = {
      closed: "This call has ended.",
      completed: "This call has ended.",
      declined: "This call was declined.",
      cancelled: "This call was cancelled.",
    };
    return (
      <Shell title={invite.topic || "1:1 call"}>
        <p className="text-sm text-ink-soft">{why[access]}</p>
        <BackLink href={backHref} />
      </Shell>
    );
  }

  const endsAt = inviteEndsAt(invite);
  if (access === "early") {
    const opens = isStaff ? CALL_STAFF_OPENS_MINUTES_BEFORE : JOIN_OPENS_MINUTES_BEFORE;
    return (
      <Shell title={invite.topic || "1:1 call"}>
        <p className="text-sm text-ink-soft">
          This opens {opens} minutes before it starts —{" "}
          <LocalTime value={invite.startsAt} />.
        </p>
        <BackLink href={backHref} />
      </Shell>
    );
  }

  // Staff are meeting the student; the student is meeting the team.
  const callTitle =
    invite.topic ||
    `1:1 with ${isStaff ? invite.inviteeName : joinNames(staffNames(invite))}`;

  // batch0 Live. A 1:1 needs no room to exist in advance: everyone on it is
  // known from the invite row, so each is handed everyone else's inbox and
  // they connect directly.
  //
  // What this render knows is the call as it stands NOW. Someone added while
  // it runs (addCallCohosts) reaches the people already in the room through
  // the heartbeat, which answers a call with its roster (announcePresence),
  // and the room elects its recorder from the server's staff list from then
  // on — `recorderIds` here is only where it starts.
  const everyone = [
    { id: invite.inviteeId, name: invite.inviteeName },
    { id: invite.hostId, name: invite.hostName },
    ...invite.cohosts.map((c) => ({ id: c.id, name: c.name })),
  ];
  const self = everyone.find((p) => p.id === profile.id);
  return (
    <BuiltinCallRoom
      inviteId={invite.id}
      startsAt={invite.startsAt}
      title={callTitle}
      selfUserId={profile.id}
      recorderIds={callStaffIds(invite)}
      selfName={self?.name || profile.full_name || "You"}
      otherName={joinNames(
        everyone.filter((p) => p.id !== profile.id).map((p) => p.name),
      )}
      endsAt={endsAt}
      backHref={backHref}
    />
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <Card className="mt-4">{children}</Card>
    </div>
  );
}

function BackLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="mt-4 inline-block text-sm text-phosphor-ink hover:underline"
    >
      ← All calls
    </Link>
  );
}
