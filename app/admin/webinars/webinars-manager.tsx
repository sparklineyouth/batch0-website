"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LiveDot } from "@/components/live/call-stage";
import { getActionError } from "@/lib/action-error";
import { saveEvent } from "@/app/admin/events/actions";
import {
  endLive,
  reopenLive,
} from "@/app/dashboard/events/[id]/live/room-actions";
import {
  eventLiveStatus,
  relativeTime,
  roomAccess,
  roomIsOpen,
  roomWindow,
  normalizeDisplayViewers,
  webinarHasBegun,
  type LiveEvent,
} from "@/lib/live";
import { isHostedOnBatch0, isPremiere } from "@/lib/webinars";
import {
  isSunday,
  localDateTime,
  localHhmm,
  upcomingSundays,
  webinarTitle,
  webinarWeek,
} from "@/lib/webinar-schedule";
import {
  Plus,
  Pencil,
  Video,
  Radio,
  ExternalLink,
  ClipboardList,
} from "lucide-react";

/**
 * One row of the list. `liveEndedAt` (on LiveEvent) and `liveStartedAt` are
 * the server's stamps: End for everyone, and the premiere's early handover.
 */
export type Webinar = LiveEvent & {
  visibility: string;
  /** Optional so fixtures (app/dev/live/preview.tsx) need not invent one. */
  liveStartedAt?: string | null;
};
type Cohort = { id: string; name: string; startsOn: string | null };

const DURATIONS = [30, 45, 60, 90, 120];

/** How far ahead the Sunday picker looks. A quarter is plenty; anything
 *  further is a plan, not a schedule. */
const SUNDAYS_AHEAD = 13;

/** When no earlier webinar exists to copy the time from. */
const FALLBACK_TIME = "12:00";

const VISIBILITIES = [
  {
    value: "enrolled",
    label: "Enrolled students",
    hint: "Everyone in the cohort sees it on their events page.",
  },
  {
    value: "staff",
    label: "Staff only — rehearsal",
    hint: "Students never see it. Staff can open it to test before going live to students, and nothing is emailed afterwards.",
  },
  { value: "public", label: "Public", hint: "Anyone signed in can join." },
];

/**
 * Schedule and review webinars.
 *
 * The form deliberately asks less than the full event editor: a webinar needs
 * a title, a Sunday, a time, a length, and who may watch. Everything else an
 * event can carry — location, recording URL, Discord cross-post — is still one
 * click away in /admin/events, and pre-filling this form with all of it would
 * bury the fields that actually matter.
 *
 * Webinars are on Sundays, full stop (lib/webinar-schedule.ts). The date
 * field is therefore a list of upcoming Sundays rather than a free picker:
 * the rule is enforced by what the form can express, not by an error after
 * the fact — though `schedule` re-checks anyway, since a rule that lives only
 * in a dropdown is one refactor away from gone.
 */
export function WebinarsManager({
  live,
  upcoming,
  past,
  now: nowProp,
  cohorts,
  needsProviderRoom,
}: {
  live: Webinar[];
  upcoming: Webinar[];
  past: Webinar[];
  /**
   * The server's clock for this render (ISO). Every row reads it, so the rows
   * agree with the server's grouping and the first client paint matches the
   * server's. Optional only for the dev preview, which falls back to the
   * mount-time clock.
   */
  now?: string;
  cohorts: Cohort[];
  /**
   * True only on the Daily path, where a webinar is not joinable until a
   * provider-side room exists. batch0 Live has no such room — the event id is
   * the room — so a webinar is joinable the moment it is scheduled, and
   * gating the button on `roomName` would hide it forever.
   */
  needsProviderRoom: boolean;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [fallbackNow] = useState(() => new Date().toISOString());
  const now = nowProp ?? fallbackNow;

  // "Same time as last week." The most useful default for a weekly series is
  // whatever the series already runs at; the next upcoming one is the best
  // witness, then whatever is live, then the most recent past one.
  const sample = upcoming[0] ?? live[0] ?? past[0];
  const defaultTime = sample
    ? localHhmm(new Date(sample.startsAt))
    : FALLBACK_TIME;

  function schedule(draft: {
    title: string;
    description: string;
    sunday: string;
    time: string;
    durationMinutes: number;
    visibility: string;
    cohortId: string | null;
    notify: boolean;
    displayViewerCount: number | null;
  }) {
    setError(undefined);
    const startsAt = localDateTime(draft.sunday, draft.time);
    if (Number.isNaN(startsAt.getTime())) {
      setError("That start time isn't valid.");
      return;
    }
    if (!isSunday(startsAt)) {
      setError("Webinars are on Sundays only.");
      return;
    }
    if (startsAt.getTime() < Date.now()) {
      setError("That Sunday's start time has already passed.");
      return;
    }
    start(async () => {
      try {
        await saveEvent(
          {
            cohort_id: draft.cohortId,
            // Was "workshop" — a webinar had no type of its own, so this page
            // wrote one thing and identified webinars by another (`live_mode`
            // below). Migration 0084 gives it a real type; the page's filter
            // now accepts either, so the webinars scheduled before this change
            // keep showing up here.
            type: "webinar",
            title: draft.title.trim(),
            description: draft.description.trim() || null,
            starts_at: startsAt.toISOString(),
            ends_at: new Date(
              startsAt.getTime() + draft.durationMinutes * 60_000,
            ).toISOString(),
            location: null,
            zoom_url: null,
            recording_url: null,
            visibility: draft.visibility as any,
            display_viewer_count: draft.displayViewerCount,
            // The point of this page: hosting is on, not a toggle to remember.
            live_mode: "hosted",
          },
          draft.notify,
        );
        setComposing(false);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  if (composing) {
    return (
      <ScheduleForm
        cohorts={cohorts}
        defaultTime={defaultTime}
        onSubmit={schedule}
        onCancel={() => setComposing(false)}
        pending={pending}
        error={error}
      />
    );
  }

  const nothing =
    live.length === 0 && upcoming.length === 0 && past.length === 0;

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button onClick={() => setComposing(true)}>
          <Plus className="h-4 w-4" /> Schedule a webinar
        </Button>
      </div>

      {nothing ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center">
          <Radio className="mx-auto h-6 w-6 text-ink-faint" />
          <p className="mt-3 text-sm text-ink">No webinars yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-ink-faint">
            They run on Sundays. Schedule one as <strong>Staff only</strong>{" "}
            first — you can walk through the whole thing without a single
            student seeing it.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {live.length > 0 && (
            <Section label="Live now" accent>
              {live.map((w) => (
                <Row
                  key={w.id}
                  webinar={w}
                  now={now}
                  needsProviderRoom={needsProviderRoom}
                />
              ))}
            </Section>
          )}
          {upcoming.length > 0 && (
            <Section label="Upcoming">
              {upcoming.map((w) => (
                <Row
                  key={w.id}
                  webinar={w}
                  now={now}
                  needsProviderRoom={needsProviderRoom}
                />
              ))}
            </Section>
          )}
          {past.length > 0 && (
            <Section label="Past">
              {past.map((w) => (
                <Row
                  key={w.id}
                  webinar={w}
                  now={now}
                  needsProviderRoom={needsProviderRoom}
                />
              ))}
            </Section>
          )}
        </div>
      )}

      {error && (
        <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function Section({
  label,
  accent,
  children,
}: {
  label: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2
        className={`mb-3 text-xs font-semibold uppercase tracking-[0.18em] ${
          accent ? "text-phosphor-ink" : "text-ink-faint"
        }`}
      >
        {label}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({
  webinar: w,
  now,
  needsProviderRoom,
}: {
  webinar: Webinar;
  now: string;
  needsProviderRoom: boolean;
}) {
  // The request's clock, not the viewer's — the same instant the page grouped
  // by, so a row never disagrees with the section it sits in.
  const at = new Date(now);
  const status = eventLiveStatus(w, at);
  const hosted = isHostedOnBatch0(w.liveMode);
  // "Host room" follows the HOST window (an hour before the start to three
  // hours after the end — roomAccess with isHost), not the audience's
  // fifteen minutes. Checking the camera and loading the deck is why an admin
  // arrives early, and the button used to be hidden until fifteen minutes
  // out. It stays after End too: a staff host entering an ended room lands on
  // the ended screen, which is where Reopen lives.
  const hostWindowOpen = roomIsOpen(
    roomAccess({
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      liveEndedAt: w.liveEndedAt,
      isHost: true,
      hostPresent: false,
      now: at,
    }),
  );
  const canHost = hosted && hostWindowOpen && (!needsProviderRoom || !!w.roomName);

  return (
    <div className="rounded-2xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{w.title}</h3>
            {status === "live" && <LiveDot />}
            {status === "ended" && <Chip>Ended</Chip>}
            {isPremiere(w.liveMode) && <Chip>premiere</Chip>}
            {!hosted && <Chip>external link</Chip>}
            {w.visibility === "staff" && <Chip>staff only</Chip>}
          </div>
          {w.description && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-soft">
              {w.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <LocalTime value={w.startsAt} mode="datetime-short" />
            {status === "upcoming" && (
              <span suppressHydrationWarning>{relativeTime(w.startsAt, at)}</span>
            )}
            {w.liveEndedAt && (
              <span>
                ended <LocalTime value={w.liveEndedAt} mode="time" />
              </span>
            )}
            {needsProviderRoom && hosted && !w.roomName && (
              <span className="text-amber-600 dark:text-amber-400">
                no room yet — re-save to create one
              </span>
            )}
            {w.displayViewerCount !== null && (
              <span title="Shown to everyone watching, in place of the real headcount">
                shows {w.displayViewerCount.toLocaleString()} watching
              </span>
            )}
            {w.recordingUrl && (
              <a
                href={w.recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-phosphor-ink hover:underline"
              >
                Recording →
              </a>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {canHost && (
            <ButtonLink size="sm" href={`/dashboard/events/${w.id}/live`}>
              <Video className="h-4 w-4" />
              Host room
            </ButtonLink>
          )}
          {!hosted && w.externalUrl && (
            <a
              href={w.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-phosphor-ink hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Zoom link
            </a>
          )}
          {hosted && (
            <LiveControls
              eventId={w.id}
              startsAt={w.startsAt}
              endsAt={w.endsAt}
              liveStartedAt={w.liveStartedAt ?? null}
              liveEndedAt={w.liveEndedAt}
              now={now}
            />
          )}
          <Link
            href={`/admin/events/${w.id}`}
            aria-label="Record: attendance, questions, recording"
            title="Record: attendance, questions, recording"
            className="p-1.5 text-ink-faint hover:text-ink"
          >
            <ClipboardList className="h-4 w-4" />
          </Link>
          <Link
            href={`/admin/events?edit=${encodeURIComponent(w.id)}`}
            aria-label="Edit in the events editor"
            title="Edit in the events editor"
            className="p-1.5 text-ink-faint hover:text-ink"
          >
            <Pencil className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
      {children}
    </span>
  );
}

/**
 * End for everyone / Reopen, from outside the room.
 *
 * Exported because /admin/events/[id] shows the same pair beside its live
 * status. Both call the room's own server actions (endLive / reopenLive in
 * room-actions.ts), which are staff-gated, idempotent, and bounded only by the
 * hard stop (end + 3h) — not by the audience window — so an admin can close a
 * webinar a host walked away from, or undo an accidental End, without going
 * on air. End does exactly what the in-room End does: everyone in the room is
 * told within a second or two (the stage `room-changed` hint), viewers land on
 * "This webinar has ended", attendance and polls close.
 *
 * What is offered, by the same clock the page grouped with:
 *   - End for everyone: not ended, started (or handed over early), and before
 *     the hard stop. Not before the start — ending a webinar nobody has begun
 *     would show students "Ended" for a talk that never happened; to take one
 *     off the calendar, edit or delete the event. `endLive` refuses it too
 *     (webinarHasBegun, the same rule), so the room cannot do it either.
 *   - Reopen: ended, and before the hard stop.
 *
 * Nothing here reconnects anybody. After a Reopen, the room's ended screens
 * notice on their slow poll: hosts and viewers on the ended screen are offered
 * Rejoin, and a host in the ended green room gets the ordinary Start back.
 */
export function LiveControls({
  eventId,
  startsAt,
  endsAt,
  liveStartedAt,
  liveEndedAt,
  now,
}: {
  eventId: string;
  startsAt: string;
  endsAt: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  /** ISO. The server's clock for this render. */
  now: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmEnd, setConfirmEnd] = useState(false);

  const t = new Date(now).getTime();
  const w = roomWindow(startsAt, endsAt);
  const beforeHardStop = t <= w.hardCloseAt;
  // The room's own rule (canEnd in room-actions.ts), which endLive enforces.
  const started = webinarHasBegun(startsAt, liveStartedAt, t);
  const canEndNow = !liveEndedAt && started && beforeHardStop;
  const canReopen = !!liveEndedAt && beforeHardStop;

  function run(action: () => Promise<unknown>) {
    setError(undefined);
    start(async () => {
      try {
        await action();
        setConfirmEnd(false);
        router.refresh();
      } catch (err: any) {
        setConfirmEnd(false);
        setError(getActionError(err));
      }
    });
  }

  if (!canEndNow && !canReopen) return null;

  return (
    <>
      {canEndNow && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => setConfirmEnd(true)}
        >
          End for everyone
        </Button>
      )}
      {canReopen && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => reopenLive(eventId))}
        >
          {pending ? "Reopening…" : "Reopen"}
        </Button>
      )}
      {error && (
        <span className="basis-full text-right text-xs text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirmEnd}
        title="End this webinar for everyone?"
        description={
          <p>
            Everyone in the room is disconnected and sees &ldquo;This webinar
            has ended&rdquo; — hosts and guest speakers included. Chat,
            questions and polls close for the audience. You can Reopen it
            afterwards, until three hours past the scheduled end.
          </p>
        }
        confirmLabel="End for everyone"
        cancelLabel="Keep it running"
        destructive
        pending={pending}
        onConfirm={() => run(() => endLive(eventId))}
        onCancel={() => !pending && setConfirmEnd(false)}
      />
    </>
  );
}

function ScheduleForm({
  cohorts,
  defaultTime,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  cohorts: Cohort[];
  defaultTime: string;
  onSubmit: (d: {
    title: string;
    description: string;
    sunday: string;
    time: string;
    durationMinutes: number;
    visibility: string;
    cohortId: string | null;
    notify: boolean;
    displayViewerCount: number | null;
  }) => void;
  onCancel: () => void;
  pending: boolean;
  error?: string;
}) {
  // Computed once: the list must not shift under the admin mid-form if
  // midnight passes while it is open.
  const [sundays] = useState(() => upcomingSundays(new Date(), SUNDAYS_AHEAD));
  const [sunday, setSunday] = useState(sundays[0]);
  const [time, setTime] = useState(defaultTime);
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState(60);
  // Staff-only by default: the safe rehearsal, one dropdown away from going
  // live to students. Defaulting the other way makes the first mistake public.
  const [visibility, setVisibility] = useState("staff");
  const [cohortId, setCohortId] = useState<string>(cohorts[0]?.id ?? "");
  const [notify, setNotify] = useState(false);
  // Optional "shown attendees". Blank means the room hides turnout as usual;
  // a number is announced to everyone in place of the hidden roster. Kept as
  // the raw string so the field can be emptied, and normalized on submit.
  const [shownAttendees, setShownAttendees] = useState("");
  const displayViewerCount = normalizeDisplayViewers(shownAttendees);

  // The name follows the Sunday — "Week 3 Webinar" — until the admin types
  // one of their own, after which the pick stops touching it. A title the
  // form silently rewrote after someone edited it is worse than no default.
  const cohort = cohorts.find((c) => c.id === cohortId) ?? cohorts[0];
  const weekOf = (ymd: string) => webinarWeek(ymd, cohort?.startsOn);
  const suggested = webinarTitle(sunday, weekOf(sunday));
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const title = customTitle ?? suggested;

  const hint = VISIBILITIES.find((v) => v.value === visibility)?.hint;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">Schedule a webinar</h2>

      <div>
        <Label>Title</Label>
        <Input
          required
          value={title}
          onChange={(e) => setCustomTitle(e.target.value)}
          placeholder={suggested}
        />
        {customTitle !== null && customTitle !== suggested && (
          <p className="mt-1.5 text-xs text-ink-faint">
            Suggested:{" "}
            <button
              type="button"
              onClick={() => setCustomTitle(null)}
              className="text-phosphor-ink hover:underline"
            >
              {suggested}
            </button>
          </p>
        )}
      </div>

      <div>
        <Label>Description (optional)</Label>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What you'll cover, and what to bring."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label>Sunday</Label>
          <Select value={sunday} onChange={(e) => setSunday(e.target.value)}>
            {sundays.map((ymd) => {
              const week = weekOf(ymd);
              return (
                <option key={ymd} value={ymd}>
                  {sundayLabel(ymd)}
                  {week !== null ? ` · Week ${week}` : ""}
                </option>
              );
            })}
          </Select>
        </div>
        <div>
          <Label>Time</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <div>
          <Label>Runs for</Label>
          <Select
            value={String(duration)}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Who can watch</Label>
          <Select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
          >
            {VISIBILITIES.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
          {hint && <p className="mt-1.5 text-xs text-ink-faint">{hint}</p>}
        </div>
        <div>
          <Label>Cohort (optional)</Label>
          <Select
            value={cohortId}
            onChange={(e) => setCohortId(e.target.value)}
          >
            <option value="">— Any —</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label>Shown attendees (optional)</Label>
        <Input
          type="number"
          min={0}
          inputMode="numeric"
          value={shownAttendees}
          onChange={(e) => setShownAttendees(e.target.value)}
          placeholder="Leave blank to hide the count"
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          {displayViewerCount !== null
            ? `Everyone watching sees “${displayViewerCount.toLocaleString()} watching,” whoever's actually here. Leave blank to keep turnout hidden.`
            : "Leave blank and the audience never sees a count. Set a number to announce that many — e.g. 43 — to everyone watching, in place of the hidden headcount."}
        </p>
      </div>

      <label className="flex items-start gap-2.5 rounded-md border border-line bg-wash px-3 py-2.5">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          disabled={visibility === "staff"}
          className="mt-0.5"
        />
        <span className="text-xs">
          <span className="font-medium text-ink">
            Notify the cohort by email and Discord
          </span>
          <span className="mt-0.5 block text-ink-faint">
            {visibility === "staff"
              ? "Unavailable for a staff-only rehearsal — there's nobody to tell."
              : "Sends an announcement now, with a link students can use from 15 minutes before the start."}
          </span>
        </span>
      </label>

      {/*
        Said plainly because every half of it used to be wrong: the room is not
        "yours alone" (every admin and anyone with Manage events can broadcast,
        and so can a guest speaker added in the events editor), and it does not
        simply close at end+30 — it stays open while a host is still on, and it
        ends when a host presses End for everyone.
      */}
      <p className="rounded-md border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
        Students can come in from 15 minutes before the start; hosts from an
        hour before. It runs until a host presses End for everyone — or, if
        nobody does, closes 30 minutes after the end once no host is left.
        Admins and staff with Manage events, plus any guest speakers you add,
        can broadcast — students watch, ask questions beside the video, and
        can&rsquo;t see each other
        {displayViewerCount !== null
          ? ". They see the shown-attendees count above, not the real one."
          : " or how many are here."}
      </p>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex gap-2 pt-1">
        <Button
          disabled={pending || !title.trim()}
          onClick={() =>
            onSubmit({
              title,
              description,
              sunday,
              time,
              durationMinutes: duration,
              visibility,
              cohortId: cohortId || null,
              notify: visibility === "staff" ? false : notify,
              displayViewerCount,
            })
          }
        >
          {pending ? "Scheduling…" : "Schedule webinar"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** "Sun, Sep 20" — the Sunday as the admin's own calendar shows it. */
function sundayLabel(ymd: string): string {
  return localDateTime(ymd, "12:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
