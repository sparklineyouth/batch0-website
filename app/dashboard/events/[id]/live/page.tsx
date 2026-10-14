import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  JOIN_OPENS_MINUTES_BEFORE,
  webinarHasBegun,
  type LiveRole,
} from "@/lib/live";
import { isHostedOnBatch0, type EventAsset } from "@/lib/webinars";
import {
  listAssets,
  listSpeakers,
  loadWebinarPanelInitial,
  signAssets,
} from "@/lib/webinar-data";
import { resolveEventAccess, roomAccessFor } from "@/lib/live-access";
import { claimSpeakerSlot } from "@/app/admin/events/webinar-actions";
import { BuiltinEventRoom } from "./builtin-room";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { EventRecordings } from "@/components/live/recording-player";

export const metadata = {
  title: "Live · batch0",
  robots: { index: false, follow: false },
};

// Per-user, per-moment access: nothing here is worth caching.
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
  //                          name, owns End / Reopen (any host may record).
  //                          Admins are
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
  const backHref = isStaffHost ? "/admin/events" : "/dashboard/events";

  // An external event has no room to join; send them to the list, which shows
  // the Zoom link.
  //
  // Both modes batch0 hosts pass here: a legacy premiere row runs as an
  // ordinary hosted room (premiere is retired).
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

  // The window, per role (roomAccess in lib/live.ts):
  //
  //   hosts    any time until three hours after the scheduled end —
  //            INCLUDING after End, so staff reach the ended screen and can
  //            Reopen.
  //   viewers  from 15 minutes before, or as soon as a host has gone live;
  //            refused once the webinar has been ended; and past end+30m only
  //            while a host is still present.
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
        {files && <SessionFiles eventId={ev.id} files={files} />}
        <BackLink href={backHref} />
      </Shell>
    );
  }
  if (where === "early" || where === "closed") {
    const files = where === "closed" ? await sharedSessionFiles(ev.id) : null;
    return (
      <Shell title={ev.title}>
        {where === "early" ? (
          <p className="text-sm text-ink-soft">
            {`This opens ${JOIN_OPENS_MINUTES_BEFORE} minutes before it starts`}{" "}
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
        {files && <SessionFiles eventId={ev.id} files={files} />}
        <BackLink href={backHref} />
      </Shell>
    );
  }

  const speakers = await listSpeakers(ev.id);

  // The credentials are issued by a server action once the browser is
  // actually joining, so this page renders as fast as its own queries.
  const audienceMode = ev.audienceMode;

  // The deck, and the side panel's first state, shaped for this reader by
  // the same loader the panel's own reads use. Premiere is retired: a legacy
  // premiere row runs as an ordinary hosted room.
  const [deck, panel] = await Promise.all([
    listAssets(ev.id, ["deck", "handout"]),
    loadWebinarPanelInitial(ev.id, access),
  ]);

  return (
    <BuiltinEventRoom
      eventId={ev.id}
      // Their peer id: a peer's id is its user id.
      selfUserId={access.userId}
      selfName={profile?.full_name || "Host"}
      title={ev.title}
      startsAt={ev.startsAt}
      endsAt={ev.endsAt}
      role={role}
      isStaffHost={isStaffHost}
      // Staff from the start; a guest speaker's answer (it depends on who
      // else is present) arrives with the room's live-state poll.
      canEnd={isStaffHost && webinarHasBegun(ev.startsAt, ev.liveStartedAt)}
      backHref={backHref}
      audienceMode={audienceMode}
      autoRecord={ev.autoRecord}
      premiere={null}
      liveEndedAt={ev.liveEndedAt}
      speakers={speakers}
      deck={deck.map((a) => ({
        id: a.id,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
      }))}
      panel={panel}
    />
  );
}

type SignedFile = EventAsset & { url: string | null };

/**
 * The recording and the slides, once the follow-up has gone out — or null.
 *
 * The follow-up email says "everything from the session is on the event
 * page" and links here. Listed only once `assets_shared_at` is set — the
 * moment the email promising them went out. That is the auto-share decision,
 * not an access decision (the reader already passed the room's gate; the
 * recordings API checks the same rule again for every byte it serves).
 *
 * Slides are signed per render, for an hour: short enough that a copied link
 * goes stale.
 */
async function sharedSessionFiles(
  eventId: string,
): Promise<{ decks: SignedFile[] } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("events")
    .select("assets_shared_at")
    .eq("id", eventId)
    .maybeSingle();
  if (!(data as any)?.assets_shared_at) return null;
  const decks = await signAssets(await listAssets(eventId, ["deck", "handout"]), 60 * 60);
  return { decks };
}

function SessionFiles({
  eventId,
  files,
}: {
  eventId: string;
  files: { decks: SignedFile[] };
}) {
  return (
    <div className="mt-4 space-y-3 text-sm">
      <EventRecordings eventId={eventId} />
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
