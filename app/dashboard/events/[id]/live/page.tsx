import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, getCapabilities } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createRoom,
  dailyConfigured,
  mintToken,
  roomIsLive,
} from "@/lib/daily";
import { canJoin, joinState, DEFAULT_EVENT_MINUTES, type LiveRole } from "@/lib/live";
import {
  listQuestionsForEvent,
  listQuestionsForAsker,
} from "@/lib/webinar-questions";
import { LiveRoom } from "./live-room";
import { BuiltinEventRoom } from "./builtin-room";
import { env } from "@/lib/env";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = {
  title: "Live · batch0",
  robots: { index: false, follow: false },
};

// A meeting token is minted per request and expires; there is nothing here
// worth caching, and a cached page would hand a stale token to the next
// viewer.
export const dynamic = "force-dynamic";

export default async function EventLivePage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  await requireUser();

  // Who is asking and what they're asking for are independent questions, so
  // ask them at once. This page is on the critical path of "the webinar has
  // started and I am clicking Join", and it used to serialise four round trips
  // — auth, profile, capabilities, event — before it could even begin minting
  // a token. getProfile/getCapabilities are request-cached and share a single
  // resolution, so the pair costs one trip, not two.
  //
  // The event is read through the RLS-scoped client, NOT the admin client. The
  // `events read` policy (migration 0005) already encodes exactly who may see
  // this event — public, staff, or enrolled in its cohort — so letting it
  // answer means the join gate and the visibility gate cannot disagree. A
  // viewer who isn't allowed gets no row, and therefore a 404 rather than a
  // hint that the event exists.
  const supabase = await createClient();
  const [profile, caps, { data: event }] = await Promise.all([
    getProfile(),
    getCapabilities(),
    supabase
      .from("events")
      .select(
        "id, title, description, type, starts_at, ends_at, live_mode, daily_room_name, daily_room_url",
      )
      .eq("id", params.id)
      .maybeSingle(),
  ]);

  if (!event) notFound();
  const ev = event as any;

  // An external event has no room to join; send them to the list, which shows
  // the Zoom link.
  //
  // Note what is NOT required here any more: a `daily_room_name`. The
  // built-in provider has no provider-side room to create — the event id is
  // the room — so a hosted event is joinable the moment it is scheduled.
  // That also retires a whole class of bug: 0069 moved every webinar to a
  // Sunday and left 17 of 18 pointing at a Daily room that expired before the
  // webinar started, which the join page then had to heal on the critical
  // path with an audience already waiting.
  if (ev.live_mode !== "hosted") {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          This event isn&rsquo;t hosted on batch0.
        </p>
        <BackLink />
      </Shell>
    );
  }

  // The same window the UI shows, re-checked here because this is the side
  // that hands out credentials. Without it a student could open this page
  // three weeks early and hold a valid token for a room nobody is watching.
  const state = joinState(ev.starts_at, ev.ends_at);
  if (!canJoin(state)) {
    return (
      <Shell title={ev.title}>
        {state === "early" ? (
          <p className="text-sm text-ink-soft">
            This opens 15 minutes before it starts —{" "}
            <LocalTime value={ev.starts_at} />.
          </p>
        ) : (
          <p className="text-sm text-ink-soft">This event has ended.</p>
        )}
        <BackLink />
      </Shell>
    );
  }

  // The host/viewer split, derived from the permission the admin panel already
  // uses for events. Never from anything the client sent.
  const role: LiveRole = can(caps, "events.manage") ? "host" : "viewer";

  const end = ev.ends_at
    ? new Date(ev.ends_at)
    : new Date(
        new Date(ev.starts_at).getTime() + DEFAULT_EVENT_MINUTES * 60_000,
      );

  // Seeding the Q&A panel is a query against our own database and needs
  // nothing from Daily, so it is kicked off first and awaited last: the room
  // check and the token mint below are HTTP calls to Daily, and this takes
  // the slower side off the critical path instead of adding to it.
  //
  // The Q&A seed keeps the audience-privacy split from the first paint: the
  // host gets the whole queue, a viewer only ever gets their own questions —
  // the same rule the panel's polling enforces, so nothing is briefly visible
  // that then disappears.
  const questionsPromise =
    role === "host"
      ? listQuestionsForEvent(ev.id)
      : profile
        ? listQuestionsForAsker(ev.id, profile.id)
        : Promise.resolve([]);
  // It is awaited below, where a failure still fails the page. This just
  // keeps a rejection that lands while a provider round trip is in flight
  // from being "unhandled" in the meantime.
  questionsPromise.catch(() => {});

  // ---- batch0 Live (the default) ------------------------------------------
  //
  // Nothing to mint and no provider to call: the credentials are issued by a
  // server action once the browser is actually joining, so this page renders
  // as fast as the Q&A query. The comparison with the Daily branch below is
  // the honest argument for the switch — that path cannot render at all
  // without two HTTP round trips to a third party that currently refuses
  // every media session.
  if (env.liveProvider === "builtin") {
    return (
      <BuiltinEventRoom
        eventId={ev.id}
        title={ev.title}
        role={role}
        initialQuestions={await questionsPromise}
      />
    );
  }

  // ---- Daily (opt-in via LIVE_PROVIDER=daily) -----------------------------
  if (!dailyConfigured() || !ev.daily_room_name) {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          Live video isn&rsquo;t configured on this environment.
        </p>
        <BackLink />
      </Shell>
    );
  }

  // The stored room can be dead. Daily deletes a room at its `exp` — the
  // event's end time as it was when the room was made — so a webinar moved to
  // a later date (the Sunday reschedule in migration 0069, or any edit that
  // predates saveEvent re-stamping the room) still points at a room Daily has
  // reaped. Minting a token for it succeeds server-side; the only symptom is
  // the browser failing to connect, with no way for the row to heal. So the
  // same recovery the 1:1 call page uses: a name that no longer resolves is
  // replaced by a fresh room, claimed with a compare-and-set so two people
  // arriving at once converge on one room rather than two.
  let roomName: string = ev.daily_room_name;
  let roomUrl: string = ev.daily_room_url;
  if (!(await roomIsLive(roomName, end))) {
    const admin = createAdminClient();
    const fresh = await createRoom({
      namePrefix: ev.title || "event",
      mode: "webinar",
      expiresAt: new Date(end.getTime() + 2 * 60 * 60 * 1000),
      enableRecording: true,
    });
    await admin
      .from("events")
      .update({ daily_room_name: fresh.name, daily_room_url: fresh.url })
      .eq("id", ev.id)
      // Replace only the exact dead value we saw — if someone else has
      // already swapped in a live room, theirs stands and ours is orphaned
      // and expires on its own.
      .eq("daily_room_name", roomName);
    const { data: settled } = await admin
      .from("events")
      .select("daily_room_name, daily_room_url")
      .eq("id", ev.id)
      .maybeSingle();
    roomName = (settled as any)?.daily_room_name ?? fresh.name;
    roomUrl = (settled as any)?.daily_room_url ?? fresh.url;
  }

  const [token, initialQuestions] = await Promise.all([
    mintToken({
      roomName,
      userId: profile?.id ?? "unknown",
      userName: profile?.full_name || "Guest",
      role,
      // Slightly past the end so the call can overrun, but not open-ended.
      expiresAt: new Date(end.getTime() + 60 * 60 * 1000),
    }),
    questionsPromise,
  ]);

  return (
    <LiveRoom
      title={ev.title}
      roomUrl={roomUrl}
      token={token}
      role={role}
      backHref="/dashboard/events"
      qa={{ eventId: ev.id, initialQuestions }}
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

function BackLink() {
  return (
    <Link
      href="/dashboard/events"
      className="mt-4 inline-block text-sm text-phosphor-ink hover:underline"
    >
      ← All events
    </Link>
  );
}
