import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, getCapabilities } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { dailyConfigured, mintToken } from "@/lib/daily";
import { canJoin, joinState, DEFAULT_EVENT_MINUTES, type LiveRole } from "@/lib/live";
import {
  listQuestionsForEvent,
  listQuestionsForAsker,
} from "@/lib/webinar-questions";
import { LiveRoom } from "./live-room";
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
  if (ev.live_mode !== "hosted" || !ev.daily_room_name) {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          This event isn&rsquo;t hosted on batch0.
        </p>
        <BackLink />
      </Shell>
    );
  }

  if (!dailyConfigured()) {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          Live video isn&rsquo;t configured on this environment.
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

  // Minting a token is an HTTP call to Daily; seeding the Q&A panel is a query
  // against our own database. Neither needs the other's answer, and running
  // them together takes the slower of the two off the critical path instead of
  // adding it to the total.
  //
  // The Q&A seed keeps the audience-privacy split from the first paint: the
  // host gets the whole queue, a viewer only ever gets their own questions —
  // the same rule the panel's polling enforces, so nothing is briefly visible
  // that then disappears.
  const [token, initialQuestions] = await Promise.all([
    mintToken({
      roomName: ev.daily_room_name,
      userId: profile?.id ?? "unknown",
      userName: profile?.full_name || "Guest",
      role,
      // Slightly past the end so the call can overrun, but not open-ended.
      expiresAt: new Date(end.getTime() + 60 * 60 * 1000),
    }),
    role === "host"
      ? listQuestionsForEvent(ev.id)
      : profile
        ? listQuestionsForAsker(ev.id, profile.id)
        : Promise.resolve([]),
  ]);

  return (
    <LiveRoom
      title={ev.title}
      roomUrl={ev.daily_room_url}
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
