import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ButtonLink } from "@/components/ui/button";
import { SpeakerStrip } from "@/components/live/speaker-strip";
import {
  listAssets,
  listAttendance,
  listSpeakers,
  signAssets,
} from "@/lib/webinar-data";
import { listQuestionsForEvent } from "@/lib/webinar-questions";
import {
  formatBytes,
  isHostedOnBatch0,
  normalizeAudienceMode,
} from "@/lib/webinars";
import {
  eventLiveStatus,
  roomAccess,
  roomIsOpen,
  type EventLiveStatus,
} from "@/lib/live";
import { LiveDot } from "@/components/live/call-stage";
import { LiveControls } from "@/app/admin/webinars/webinars-manager";
import {
  FileDown,
  Users,
  MessageCircleQuestion,
  Radio,
  Video,
} from "lucide-react";

export const metadata = {
  title: "Webinar · batch0 admin",
  robots: { index: false, follow: false },
};

// Attendance and the recording change while a webinar is running, and an admin
// reading this page during one wants the truth rather than a cached copy.
export const dynamic = "force-dynamic";

/**
 * What a webinar left behind.
 *
 * The admin list answers "what is scheduled". This answers "what happened" —
 * who came and for how long, what they asked, what was recorded, and what the
 * follow-up will send. It exists because all four of those were being written
 * to the database with nowhere to read them: attendance has been recorded since
 * migration 0076 and had no reader at all.
 *
 * Read-only on purpose, with one exception. Moderation happens in the room,
 * while it can still change what the audience sees; by the time anyone opens
 * this page the webinar is usually over and the useful thing is an honest
 * record, not another set of buttons.
 *
 * The exception is the live status at the top: whether the room is running,
 * when it went live and when it was ended, a "Host room" link, and End for
 * everyone / Reopen. Those are the controls an admin needs WITHOUT going on
 * air — closing a room a host walked away from, undoing an accidental End —
 * and they are the same room-actions the in-room End uses, not a second
 * implementation.
 */
export default async function AdminWebinarPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  await requirePermission("events.manage");

  const admin = createAdminClient();
  const { data: event } = await admin
    .from("events")
    .select(
      "id, title, type, starts_at, ends_at, visibility, live_mode, audience_mode, auto_record, auto_share, assets_shared_at, live_started_at, live_ended_at, premiere_seconds",
    )
    .eq("id", id)
    .maybeSingle();
  if (!event) notFound();
  const ev = event as any;

  // All four reads are independent and none is on a critical path, so they go
  // together rather than in sequence.
  const [attendance, questions, assets, speakers] = await Promise.all([
    listAttendance(id),
    listQuestionsForEvent(id),
    listAssets(id),
    listSpeakers(id, true),
  ]);

  const recordings = assets.filter((a) => a.kind === "recording");
  const files = assets.filter((a) => a.kind !== "recording");
  // Signed for an hour rather than the usual ten minutes: this is a page-render
  // batch an admin will click through over several minutes, not a single
  // per-click download.
  const signedFiles = await signAssets(files, 60 * 60);

  const viewers = attendance.filter((a) => a.role !== "host");
  const hosts = attendance.filter((a) => a.role === "host");
  const watched = viewers.filter((a) => a.minutes >= 1);
  const medianMinutes = median(watched.map((a) => a.minutes));
  const recordedSeconds = recordings.reduce(
    (n, r) => n + (r.durationSeconds ?? 0),
    0,
  );
  const mode = normalizeAudienceMode(ev.audience_mode);

  // Live state for the status card. The request's clock: this page is
  // force-dynamic, and End / Reopen refresh it.
  const now = new Date();
  const hosted = isHostedOnBatch0(ev.live_mode);
  const liveStatus = eventLiveStatus(
    {
      startsAt: ev.starts_at,
      endsAt: ev.ends_at,
      liveEndedAt: ev.live_ended_at,
    },
    now,
  );
  // The host window (start-60m to end+3h, whatever End says), not the
  // audience's: an admin is a host, and a staff host entering an ended room
  // lands on the ended screen, where Reopen is.
  const hostWindowOpen = roomIsOpen(
    roomAccess({
      startsAt: ev.starts_at,
      endsAt: ev.ends_at,
      liveEndedAt: ev.live_ended_at,
      isHost: true,
      hostPresent: false,
      now,
    }),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/admin/events"
        className="text-sm text-phosphor-ink hover:underline"
      >
        ← All events
      </Link>

      <h1 className="mt-3 font-display text-2xl tracking-[-0.02em] text-ink">
        {ev.title}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        <LocalTime value={ev.starts_at} />
        {ev.live_mode === "premiere" && " · premiere"}
        {" · "}
        {mode === "private"
          ? "private audience"
          : mode === "moderated"
            ? "moderated chat"
            : "open chat"}
      </p>

      {/* ---- Live status ------------------------------------------------ */}
      {hosted && (
        <Card className="mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Radio className="h-4 w-4 text-phosphor-ink" />
                {STATUS_LABEL[liveStatus]}
                {liveStatus === "live" && <LiveDot />}
              </h2>
              <p className="mt-1.5 text-xs text-ink-faint">
                {ev.live_started_at && (
                  <>
                    Went live <LocalTime value={ev.live_started_at} mode="time" />
                    {" · "}
                  </>
                )}
                {ev.live_ended_at ? (
                  <>
                    Ended for everyone{" "}
                    <LocalTime value={ev.live_ended_at} mode="time" />
                  </>
                ) : liveStatus === "past" ? (
                  // Not "closed": past end+30m a room stays open to its
                  // audience while a host is still on, up to end+3h. It is
                  // deliberately never auto-ended, so a wifi drop cannot end a
                  // webinar.
                  "Nobody pressed End. The room closes on its own once no host is left, and three hours after the scheduled end at the latest."
                ) : liveStatus === "live" ? (
                  "Running. End for everyone closes it for the whole room."
                ) : (
                  "Hosts can open the room from an hour before the start; students from 15 minutes before."
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {hostWindowOpen && (
                <ButtonLink size="sm" href={`/dashboard/events/${ev.id}/live`}>
                  <Video className="h-4 w-4" />
                  Host room
                </ButtonLink>
              )}
              <LiveControls
                eventId={ev.id}
                startsAt={ev.starts_at}
                endsAt={ev.ends_at}
                liveStartedAt={ev.live_started_at ?? null}
                liveEndedAt={ev.live_ended_at ?? null}
                now={now.toISOString()}
              />
            </div>
          </div>
        </Card>
      )}

      {/* The numbers, above everything else. An admin opening this page after a
          webinar is asking "did anyone come and did they stay", and the answer
          should not be below a list of files. */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Stat
          icon={<Users className="h-4 w-4" />}
          label="Attended"
          value={String(watched.length)}
          hint={
            viewers.length > watched.length
              ? `${viewers.length - watched.length} looked in for under a minute`
              : undefined
          }
        />
        <Stat
          icon={<Users className="h-4 w-4" />}
          label="Median watch time"
          value={watched.length > 0 ? `${medianMinutes} min` : "—"}
          // The median, not the mean: one person who left a tab open overnight
          // moves a mean by half an hour and tells you nothing about the room.
          hint="Half stayed longer than this"
        />
        <Stat
          icon={<MessageCircleQuestion className="h-4 w-4" />}
          label="Questions"
          value={String(questions.length)}
          hint={`${questions.filter((q) => q.status === "answered").length} answered`}
        />
      </div>

      {/* ---- Recording -------------------------------------------------- */}
      <Card className="mt-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Video className="h-4 w-4 text-phosphor-ink" />
          Recording
        </h2>
        {recordings.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            {ev.auto_record
              ? "Nothing recorded yet. Recording runs in one staff host's browser while they are on air (guest speakers never record), so either no staff host went live, or the tab was closed before the first five-minute segment finished uploading."
              : "Auto-record was off for this webinar."}
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-soft">
              {recordings.length} segment{recordings.length === 1 ? "" : "s"} ·{" "}
              {Math.round(recordedSeconds / 60)} minutes ·{" "}
              {formatBytes(
                recordings.reduce((n, r) => n + (r.sizeBytes ?? 0), 0),
              )}
            </p>
            {/*
              Segments are listed rather than stitched. The recorder writes a
              self-contained file every five minutes so a crashed tab costs one
              segment instead of the hour behind it (see docs/webinars.md), and
              joining them back into a single file needs a muxer this project
              does not have. The student-facing player walks them in order.
            */}
            <p className="mt-1 text-xs text-ink-faint">
              Segments play back-to-back for students. To get one file, download
              them in order and concatenate with ffmpeg.
            </p>
          </>
        )}
      </Card>

      {/* ---- Files ------------------------------------------------------ */}
      {signedFiles.length > 0 && (
        <Card className="mt-4">
          <h2 className="text-sm font-semibold text-ink">Deck and handouts</h2>
          <ul className="mt-3 space-y-2">
            {signedFiles.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-ink-soft">
                  {f.filename}
                  <span className="ml-2 text-xs text-ink-faint">
                    {formatBytes(f.sizeBytes)}
                  </span>
                </span>
                {f.url && (
                  <a
                    href={f.url}
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-phosphor-ink hover:underline"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-faint">
            {ev.assets_shared_at ? (
              <>
                Follow-up sent <LocalTime value={ev.assets_shared_at} />.
              </>
            ) : ev.visibility === "staff" ? (
              "Staff-only rehearsal — nothing is emailed."
            ) : ev.auto_share ? (
              "Follow-up goes out about 15 minutes after a host presses End — or 45 minutes after the scheduled end if nobody does."
            ) : (
              "Auto-share is off — nothing will be emailed."
            )}
          </p>
        </Card>
      )}

      {speakers.length > 0 && (
        <Card className="mt-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Speakers</h2>
          <SpeakerStrip speakers={speakers} />
          {speakers.some((sp) => !sp.userId) && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              Some speakers have not opened their invite link yet — they will
              join as viewers until they do.
            </p>
          )}
        </Card>
      )}

      {/* ---- Attendance -------------------------------------------------- */}
      <Card className="mt-4">
        <h2 className="text-sm font-semibold text-ink">Who was here</h2>
        {attendance.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No attendance recorded. If this webinar ran before migration 0076
            was applied, that is expected.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-faint">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Joined</th>
                  <th className="pb-2 font-medium">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {[...hosts, ...viewers].map((a) => (
                  <tr key={a.userId} className="border-b border-line/50">
                    <td className="py-2 text-ink-soft">
                      {a.name}
                      {a.role === "host" && (
                        <span className="ml-2 rounded-full bg-phosphor/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-phosphor-ink">
                          host
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-ink-faint">
                      <LocalTime value={a.joinedAt} mode="time" />
                    </td>
                    <td className="py-2 text-ink-faint">{a.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---- Questions --------------------------------------------------- */}
      {questions.length > 0 && (
        <Card className="mt-4">
          <h2 className="text-sm font-semibold text-ink">Questions asked</h2>
          <ul className="mt-3 space-y-3">
            {questions.map((q) => (
              <li key={q.id} className="border-b border-line/50 pb-3 last:border-0">
                <p className="text-sm text-ink-soft">{q.body}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {q.askerName} · <LocalTime value={q.createdAt} mode="time" /> ·{" "}
                  {q.status}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-5">
        <ButtonLink variant="secondary" href="/admin/events">
          Back to events
        </ButtonLink>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<EventLiveStatus, string> = {
  upcoming: "Not open yet",
  open: "Open — not started",
  live: "Live now",
  ended: "Ended",
  past: "Over",
};

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-wash p-3">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <span className="text-phosphor-ink">{icon}</span>
        {label}
      </p>
      {/* Size, not weight: .font-display ships one weight and font-bold on it
          is inert (globals.css forces 400). Hierarchy has to come from scale. */}
      <p className="mt-1 font-display text-2xl tracking-[-0.02em] text-ink">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/** Middle value, or the lower of the two middles. Empty is 0. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
