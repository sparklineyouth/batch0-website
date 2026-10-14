import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInvite } from "@/lib/calls";
import { createRoom, dailyConfigured, mintToken, roomIsLive } from "@/lib/daily";
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
import { LiveRoom } from "@/app/dashboard/events/[id]/live/live-room";
import { BuiltinCallRoom } from "./builtin-room";
import { env } from "@/lib/env";
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

  // ---- batch0 Live (the default) ------------------------------------------
  //
  // A 1:1 needs no room to exist in advance and none to be healed: everyone
  // on it is known from the invite row, so each is handed everyone else's
  // inbox and they connect directly. The lazy room creation, the
  // compare-and-set race between two people clicking Join at once, and the
  // dead-room recovery below all exist only because Daily needed a
  // provider-side room. None of it has an equivalent here.
  //
  // What this render knows is the call as it stands NOW. Someone added while
  // it runs (addCallCohosts) reaches the people already in the room through
  // the heartbeat, which answers a call with its roster (announcePresence),
  // and the room elects its recorder from the server's staff list from then
  // on — `recorderIds` here is only where it starts.
  if (env.liveProvider === "builtin") {
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

  // ---- Daily (opt-in via LIVE_PROVIDER=daily) -----------------------------
  if (!dailyConfigured()) {
    return (
      <Shell title={callTitle}>
        <p className="text-sm text-ink-soft">
          Live video isn&rsquo;t configured on this environment.
        </p>
        <BackLink href={backHref} />
      </Shell>
    );
  }

  // Created on first join rather than when the invite was sent. An invite that
  // is declined or ignored should never have cost a room, and a room made
  // weeks ahead would have expired before anyone arrived. Whoever arrives
  // first creates it; the second person finds it already there.
  let roomName = invite.roomName;
  let roomUrl = invite.roomUrl;
  const admin = createAdminClient();

  // A stored room can be stale. Daily deletes every room at its `exp`, but the
  // invite row keeps the name and URL — so a call joined once and rejoined
  // after the room expired points at a room that is no longer there. Minting a
  // token for a missing room still succeeds server-side; the only symptom is
  // the browser failing to connect ("Could not connect to the room"), and the
  // row never heals itself, so the call stays broken forever. A name that no
  // longer resolves is therefore cleared here and treated as if no room was
  // ever created, dropping straight into the lazy-creation path below.
  if (roomName && !(await roomIsLive(roomName))) {
    await admin
      .from("call_invites")
      .update({ daily_room_name: null, daily_room_url: null })
      .eq("id", invite.id)
      // Clear only the exact dead value we saw — if someone else has already
      // replaced it with a fresh room, leave theirs in place.
      .eq("daily_room_name", roomName);
    roomName = null;
    roomUrl = null;
  }

  if (!roomName || !roomUrl) {
    const room = await createRoom({
      namePrefix: invite.topic || "1-1",
      // Not "webinar": both people need camera and mic.
      mode: "meeting",
      expiresAt: new Date(new Date(endsAt).getTime() + 2 * 60 * 60 * 1000),
    });
    roomName = room.name;
    roomUrl = room.url;
    await admin
      .from("call_invites")
      .update({ daily_room_name: roomName, daily_room_url: roomUrl })
      .eq("id", invite.id)
      // Only claim the row if nobody else has — if both people click Join at
      // the same instant, the loser's room is simply orphaned and expires,
      // rather than overwriting the URL the winner is already connecting to.
      .is("daily_room_name", null);

    // Re-read so both racers converge on whichever room actually landed.
    const settled = await getInvite(invite.id);
    if (settled?.roomName && settled.roomUrl) {
      roomName = settled.roomName;
      roomUrl = settled.roomUrl;
    }
  }

  const token = await mintToken({
    roomName,
    userId: profile.id,
    userName: profile.full_name || "Guest",
    // Everyone is a host in a 1:1 — there is no audience to hide, and a
    // viewer token would leave someone unable to speak.
    role: "host",
    expiresAt: new Date(new Date(endsAt).getTime() + 60 * 60 * 1000),
  });

  return (
    <LiveRoom
      title={callTitle}
      roomUrl={roomUrl}
      token={token}
      role="host"
      kind="call"
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
