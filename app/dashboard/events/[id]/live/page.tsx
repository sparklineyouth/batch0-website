import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createRoom,
  dailyConfigured,
  mintToken,
  roomIsLive,
} from "@/lib/daily";
import {
  HOST_JOIN_OPENS_MINUTES_BEFORE,
  JOIN_OPENS_MINUTES_BEFORE,
  normalizeDisplayViewers,
  roomWindow,
  type LiveRole,
} from "@/lib/live";
import {
  listQuestionsForEvent,
  listQuestionsForAsker,
} from "@/lib/webinar-questions";
import {
  isHostedOnBatch0,
  isPremiere,
  premiereState,
  type EventAsset,
} from "@/lib/webinars";
import {
  listAssets,
  listSpeakers,
  signAssets,
  signedAssetUrl,
} from "@/lib/webinar-data";
import { resolveEventAccess, roomAccessFor } from "@/lib/live-access";
import { claimSpeakerSlot } from "@/app/admin/events/webinar-actions";
import { fetchRoomState } from "./room-actions";
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
    searchParams: Promise<{ speaker?: string }>;
  }
) {
  const [params, search] = await Promise.all([props.params, props.searchParams]);
  await requireUser();

  // A guest arriving on their invite link — claimed BEFORE anything reads the
  // event.
  //
  // The claim writes the speaker row that decides everything below. Reading
  // the event first (as this page used to) meant a guest outside the cohort
  // got no row back from RLS for an `enrolled` webinar and a 404 before the
  // claim ever ran, so the invited host could never become one. The claim is
  // service-role, token-bound and scoped to this event id, so running it first
  // reveals nothing: a bad or spent token (the COMMON case — it is cleared on
  // claim, and the guest will reload that same URL) is a quiet no-op, and a
  // stale link must not turn the webinar into an error page.
  if (search?.speaker) {
    await claimSpeakerSlot(params.id, search.speaker).catch(() => false);
  }

  // Who is asking, what they may do, and the event — one resolution, shared
  // with joinRoom, the room actions and the upload gate (lib/live-access.ts),
  // so the role this page renders and the role the credentials are minted
  // with come from the same code.
  //
  //   staff (events.manage)  broadcasts, moderates, sees the audience by
  //                          name, owns End / Reopen / recording. Admins are
  //                          staff through `*`, and are NEVER downgraded to
  //                          viewer: an events.manage holder the RLS read
  //                          returns nothing for is re-read with the admin
  //                          client (see live-access for why that is safe).
  //   a speaker row          this event only. Broadcasts and moderates, and is
  //                          NOT told who is watching — see `discloseNames`.
  //   everyone else          a viewer, if the `events read` policy lets them
  //                          see the event at all. A viewer who isn't allowed
  //                          gets a 404 rather than a hint that it exists.
  const [access, profile] = await Promise.all([
    resolveEventAccess(params.id),
    getProfile(),
  ]);
  if (!access.ok) {
    if (access.reason === "no-access") notFound();
    return (
      <Shell title="Live">
        <p className="text-sm text-ink-soft">
          We couldn&rsquo;t load this room just now. Try again in a moment.
        </p>
        <BackLink href="/dashboard/events" />
      </Shell>
    );
  }
  const ev = access.event;
  const role: LiveRole = access.role;
  const isStaffHost = access.isStaff;
  // Staff came from the admin list and go back there; guest speakers and
  // students go back to the events they can see.
  const backHref = isStaffHost ? "/admin/webinars" : "/dashboard/events";

  // An external event has no room to join; send them to the list, which shows
  // the Zoom link.
  //
  // Both modes batch0 hosts pass here. A premiere is a room too — the
  // recording plays in it and the live Q&A happens in it — so the older
  // `!== "hosted"` test would have made every premiere unjoinable.
  //
  // Note what is NOT required here any more: a `daily_room_name`. The
  // built-in provider has no provider-side room to create — the event id is
  // the room — so a hosted event is joinable the moment it is scheduled.
  // That also retires a whole class of bug: 0069 moved every webinar to a
  // Sunday and left 17 of 18 pointing at a Daily room that expired before the
  // webinar started, which the join page then had to heal on the critical
  // path with an audience already waiting.
  if (!isHostedOnBatch0(ev.liveMode)) {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          This event isn&rsquo;t hosted on batch0.
        </p>
        <BackLink href={backHref} />
      </Shell>
    );
  }

  // The window, per role, re-checked here because this is the side that
  // hands out credentials. Without it a student could open this page three
  // weeks early and hold a valid token for a room nobody is watching.
  //
  //   hosts    from an hour before the start (to set up) until three hours
  //            after the scheduled end — INCLUDING after End, so staff reach
  //            the ended screen and can Reopen.
  //   viewers  from 15 minutes before; refused once the webinar has been
  //            ended; and past end+30m only while a host is still present.
  const where = await roomAccessFor(access);
  if (where === "ended") {
    // Viewers only — a host's window ignores End. The ended shell, rather
    // than a green room that would hand out a Join into a finished webinar.
    const files = await sharedSessionFiles(ev.id);
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          This webinar has ended
          {ev.liveEndedAt ? (
            <>
              {" "}
              — it finished at <LocalTime value={ev.liveEndedAt} mode="time" />
            </>
          ) : null}
          . Thanks for watching.
        </p>
        {ev.recordingUrl && (
          <a
            href={ev.recordingUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-sm text-phosphor-ink hover:underline"
          >
            Watch the recording
          </a>
        )}
        {files && <SessionFiles files={files} />}
        <BackLink href={backHref} />
      </Shell>
    );
  }
  if (where === "early" || where === "closed") {
    const opensMinutes =
      role === "host" ? HOST_JOIN_OPENS_MINUTES_BEFORE : JOIN_OPENS_MINUTES_BEFORE;
    const files = where === "closed" ? await sharedSessionFiles(ev.id) : null;
    return (
      <Shell title={ev.title}>
        {where === "early" ? (
          <p className="text-sm text-ink-soft">
            {role === "host"
              ? `The room opens for hosts ${opensMinutes} minutes before it starts`
              : `This opens ${opensMinutes} minutes before it starts`}{" "}
            — <LocalTime value={ev.startsAt} />.
          </p>
        ) : (
          <p className="text-sm text-ink-soft">This webinar is over.</p>
        )}
        {where === "closed" && ev.recordingUrl && (
          <a
            href={ev.recordingUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-sm text-phosphor-ink hover:underline"
          >
            Watch the recording
          </a>
        )}
        {files && <SessionFiles files={files} />}
        <BackLink href={backHref} />
      </Shell>
    );
  }

  const speakers = await listSpeakers(ev.id);

  // The admin-announced headcount, if any — shown to everyone in the room in
  // place of the hidden roster. Sanitized here (not trusted from the row) since
  // the room renders it straight into the header.
  const displayViewerCount = normalizeDisplayViewers(ev.displayViewerCount);

  const end = new Date(roomWindow(ev.startsAt, ev.endsAt).end);

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
      : listQuestionsForAsker(ev.id, access.userId);
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
    const audienceMode = ev.audienceMode;

    // ---- Premiere -------------------------------------------------------
    //
    // Resolved on the SERVER, from the server's clock. This is the one number
    // in the feature that must not come from the browser: a viewer whose
    // laptop is four minutes fast would sit four minutes ahead of the room —
    // visibly, in chat, reacting to something nobody else has seen yet — and
    // one whose clock is out by an hour would watch a black screen and
    // conclude the webinar never started.
    //
    // `liveEndedAt` goes in too: an ended premiere is ended, not still
    // playing to the audience under an "Ended" badge.
    const premiere = isPremiere(ev.liveMode)
      ? premiereState({
          startsAt: ev.startsAt,
          premiereSeconds: ev.premiereSeconds,
          qaOpensAt: ev.qaOpensAt,
          liveStartedAt: ev.liveStartedAt,
          liveEndedAt: ev.liveEndedAt,
          endsAt: ev.endsAt,
        })
      : null;

    // The recording and the deck, signed only for the people entitled to them
    // right now. Read together because both are one query against our own
    // database and neither is on the critical path of "the host pressed Start".
    // `fetchRoomState` is a server action, and calling one from a server
    // component is just calling an async function — so the chat, the question
    // queue and the polls are seeded here rather than fetched on mount. That
    // is not only a saved round trip: the panel's privacy shaping (what a
    // viewer may see in each audience mode) lives inside that one function, and
    // re-deriving a seed here would be a second copy of the rule that decides
    // whether one student's words reach another.
    const [assets, initialRoomState] = await Promise.all([
      listAssets(ev.id, ["premiere", "deck", "handout"]),
      fetchRoomState(ev.id),
    ]);
    const speakerCards = speakers;

    const premiereAsset = assets.find((a) => a.kind === "premiere") ?? null;
    // Signed for two hours rather than the usual ten minutes, and this is the
    // one place in the repo that deviates. A premiere is a single continuous
    // playback that can run the length of a talk; a ten-minute URL would expire
    // under a viewer mid-sentence, and although the player re-mints on error,
    // doing that eight times an hour for every viewer is a lot of machinery to
    // avoid one number. Two hours covers the longest premiere the CHECK allows
    // to start, and the URL is useless to anyone who cannot already see the
    // event.
    const premiereUrl = premiereAsset
      ? await signedAssetUrl(premiereAsset.storagePath, 60 * 120)
      : null;

    // Decks are offered in the room only when the admin meant them to be. The
    // default is that the follow-up email carries them AFTER the webinar —
    // handing out the slides at minute one is how an audience reads ahead
    // instead of listening.
    const deck = assets.filter((a) => a.kind !== "premiere");

    return (
      <BuiltinEventRoom
        eventId={ev.id}
        // The id every other host's browser knows this one by (a peer's id
        // is its user id) — what the recorder election compares.
        selfUserId={access.userId}
        selfName={profile?.full_name || "Host"}
        title={ev.title}
        startsAt={ev.startsAt}
        endsAt={ev.endsAt}
        role={role}
        isStaffHost={isStaffHost}
        // Staff always; a guest speaker only while no staff host is present.
        // The room-state read computes it with the server's presence data;
        // without that read (0084 not applied) only staff can end.
        canEnd={initialRoomState?.canEnd ?? isStaffHost}
        backHref={backHref}
        audienceMode={audienceMode}
        displayViewerCount={displayViewerCount}
        autoRecord={ev.autoRecord}
        premiere={
          premiere && premiereUrl && ev.premiereSeconds
            ? {
                ...premiere,
                url: premiereUrl,
                durationSeconds: ev.premiereSeconds,
              }
            : null
        }
        liveEndedAt={ev.liveEndedAt}
        speakers={speakerCards}
        deck={deck.map((a) => ({
          id: a.id,
          filename: a.filename,
          sizeBytes: a.sizeBytes,
        }))}
        initialQuestions={await questionsPromise}
        initialRoomState={initialRoomState}
      />
    );
  }

  // ---- Daily (opt-in via LIVE_PROVIDER=daily) -----------------------------
  //
  // Behind exactly the same gates as the built-in room above — access, role,
  // window, End — because they all ran before this branch.
  if (!dailyConfigured() || !ev.dailyRoomName) {
    return (
      <Shell title={ev.title}>
        <p className="text-sm text-ink-soft">
          Live video isn&rsquo;t configured on this environment.
        </p>
        <BackLink href={backHref} />
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
  let roomName: string = ev.dailyRoomName;
  let roomUrl: string = ev.dailyRoomUrl ?? "";
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
      userId: access.userId,
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
      backHref={backHref}
      displayViewerCount={displayViewerCount}
      qa={{ eventId: ev.id, initialQuestions }}
    />
  );
}

type SignedFile = EventAsset & { url: string | null };

/**
 * The recording and the slides, once the follow-up has gone out — or null.
 *
 * The follow-up email says "everything from the session is on the event
 * page" and links here, and the ended screen used to show at most an
 * admin-pasted `recording_url`: the segments the room itself recorded, and
 * the deck, were on no page a student could reach. They are listed now, but
 * only once `assets_shared_at` is set — the moment the email promising them
 * went out. That is the auto-share decision, not an access decision (the
 * reader already passed the room's gate): a webinar without auto-share, or
 * one whose follow-up has not been sent, shows exactly what it showed before.
 *
 * Signed per render, for an hour, like the admin record page: short enough
 * that a copied link goes stale, long enough to click through the parts.
 */
async function sharedSessionFiles(
  eventId: string,
): Promise<{ recordings: SignedFile[]; decks: SignedFile[] } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select("assets_shared_at")
    .eq("id", eventId)
    .maybeSingle();
  if (!(data as any)?.assets_shared_at) return null;
  const assets = await listAssets(eventId, ["recording", "deck", "handout"]);
  if (assets.length === 0) return null;
  const [recordings, decks] = await Promise.all([
    // Recordings open in the browser (no download filename), decks download.
    Promise.all(
      assets
        .filter((a) => a.kind === "recording")
        .map(async (a) => ({
          ...a,
          url: await signedAssetUrl(a.storagePath, 60 * 60),
        })),
    ),
    signAssets(
      assets.filter((a) => a.kind !== "recording"),
      60 * 60,
    ),
  ]);
  return { recordings, decks };
}

function SessionFiles({
  files,
}: {
  files: { recordings: SignedFile[]; decks: SignedFile[] };
}) {
  const parts = files.recordings.length;
  return (
    <div className="mt-4 space-y-3 text-sm">
      {parts > 0 && (
        <div>
          <p className="font-medium text-ink">The recording</p>
          <ul className="mt-1 space-y-1">
            {files.recordings.map((r, i) =>
              r.url ? (
                <li key={r.id}>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-phosphor-ink hover:underline"
                  >
                    {parts === 1 ? "Watch" : `Part ${i + 1} of ${parts}`}
                    {r.durationSeconds
                      ? ` · ${Math.max(1, Math.round(r.durationSeconds / 60))} min`
                      : ""}
                  </a>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
      {files.decks.length > 0 && (
        <div>
          <p className="font-medium text-ink">The slides</p>
          <ul className="mt-1 space-y-1">
            {files.decks.map((d) =>
              d.url ? (
                <li key={d.id}>
                  <a href={d.url} className="text-phosphor-ink hover:underline">
                    {d.filename}
                  </a>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
    </div>
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
      className="mt-4 block text-sm text-phosphor-ink hover:underline"
    >
      ← Back
    </Link>
  );
}
