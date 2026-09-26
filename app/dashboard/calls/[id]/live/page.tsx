import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getProfile, getCapabilities } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInvite } from "@/lib/calls";
import { createRoom, dailyConfigured, mintToken, roomIsLive } from "@/lib/daily";
import { callsHomeFor } from "@/lib/permissions";
import { resolveCallAccess } from "@/lib/live-access";
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

  // A 1:1 is private to its two people. Not "can you see this page" but
  // "are you one of the two" — an admin browsing the safeguarding list can
  // read that a call happened without being able to walk into it. A
  // non-party gets the same 404 as a call that does not exist; that is the
  // deliberate safeguarding rule, not a gap. (An admin who BOOKED a call is
  // its owner, and is let in like any other owner.)
  //
  // The same resolution joinRoom and endCall use (lib/live-access.ts), so the
  // page, the credentials and End call agree about who owns the call and
  // whether it is still running.
  const [access, caps, profile] = await Promise.all([
    resolveCallAccess(params.id),
    getCapabilities(),
    getProfile(),
  ]);
  if (!access.ok) {
    if (access.reason === "no-access") notFound();
    return (
      <Shell title="1:1 call">
        <p className="text-sm text-ink-soft">
          We couldn&rsquo;t load this call just now. Try again in a moment.
        </p>
        <BackLink href="/dashboard/calls" />
      </Shell>
    );
  }

  // Back goes where each person manages their calls: the owner to their
  // admin, mentor or investor calls page; the invitee (always a student) to
  // theirs. Sending everyone to /dashboard/calls bounced mentors to /mentor
  // and showed admins a list where their call seemed to have vanished.
  const isOwner = access.isOwner;
  const backHref = isOwner ? callsHomeFor(caps) : "/dashboard/calls";
  const title = access.topic || "1:1 call";

  // Everything but "joinable" is said in words. Note that an accepted call
  // whose window has closed counts as completed here, exactly as it does on
  // the cards and in joinRoom — nobody pressing End call does not make a call
  // from last week still "on".
  switch (access.phase) {
    case "invited":
      return (
        <Shell title={title}>
          <p className="text-sm text-ink-soft">
            This call hasn&rsquo;t been accepted yet.
          </p>
          <BackLink href={backHref} />
        </Shell>
      );
    case "upcoming":
      return (
        <Shell title={title}>
          <p className="text-sm text-ink-soft">
            This opens 15 minutes before it starts —{" "}
            <LocalTime value={access.startsAt} />.
          </p>
          <BackLink href={backHref} />
        </Shell>
      );
    case "completed":
      return (
        <Shell title={title}>
          <p className="text-sm text-ink-soft">This call has ended.</p>
          <BackLink href={backHref} />
        </Shell>
      );
    case "cancelled":
    case "declined":
      return (
        <Shell title={title}>
          <p className="text-sm text-ink-soft">This call was {access.phase}.</p>
          <BackLink href={backHref} />
        </Shell>
      );
    case "joinable":
      break;
  }

  const callTitle = access.topic || `1:1 with ${access.otherName}`;

  // ---- batch0 Live (the default) ------------------------------------------
  //
  // A 1:1 needs no room to exist in advance and none to be healed: both
  // parties are known from the invite row, so each is handed the other's
  // inbox and they connect directly. The lazy room creation, the
  // compare-and-set race between two people clicking Join at once, and the
  // dead-room recovery below all exist only because Daily needed a
  // provider-side room. None of it has an equivalent here.
  if (env.liveProvider === "builtin") {
    return (
      <BuiltinCallRoom
        inviteId={access.inviteId}
        title={callTitle}
        backHref={backHref}
        isOwner={isOwner}
        otherName={access.otherName}
        endsAt={access.endsAt}
      />
    );
  }

  const endsAt = access.endsAt;
  // The Daily branch needs the provider room columns, which only the invite
  // row carries.
  const invite = await getInvite(access.inviteId);
  if (!invite) notFound();

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
    userId: access.userId,
    userName: profile?.full_name || "Guest",
    // Both parties are hosts in a 1:1 — there is no audience to hide, and a
    // viewer token would leave one of them unable to speak.
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
