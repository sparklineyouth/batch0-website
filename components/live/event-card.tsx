"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/live-dot";
import { relativeTime, type LiveEvent } from "@/lib/live";
import { studentEventStatus } from "@/lib/event-form";
import { isHostedOnBatch0 } from "@/lib/webinars";
import { CalendarDays, MapPin, Video, ExternalLink } from "lucide-react";

/** What the card reads. A subset of LiveEvent, so callers build only this. */
export type StudentEvent = Pick<
  LiveEvent,
  | "id"
  | "title"
  | "description"
  | "type"
  | "startsAt"
  | "endsAt"
  | "location"
  | "liveMode"
  | "externalUrl"
  | "recordingUrl"
  | "hostName"
  | "liveEndedAt"
> & { liveStartedAt?: string | null };

/**
 * An event on the student events page. A batch0-hosted event links to its
 * room (/dashboard/events/<id>/live) while it is joinable — from 15 minutes
 * before, or as soon as a host goes live; an external one opens its link.
 * An ended event shows "Ended" and no Join, whatever the clock says.
 */
export function EventCard({
  event,
  upcoming,
  initialStatus,
}: {
  event: StudentEvent;
  upcoming: boolean;
  /** The server's answer, shown until the browser's clock takes over. */
  initialStatus?: ReturnType<typeof studentEventStatus>;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // `ended` needs no clock; everything else waits for `now` (see LocalTime).
  const ended = !!event.liveEndedAt;
  const status = ended
    ? "ended"
    : now
      ? studentEventStatus(
          {
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            liveStartedAt: event.liveStartedAt ?? null,
            liveEndedAt: event.liveEndedAt,
          },
          now,
        )
      : (initialStatus ?? null);
  const hosted = isHostedOnBatch0(event.liveMode);
  const joinable = status === "open" || status === "live";
  const live = status === "live";
  // Only an external event has a link to leave for.
  const externalUrl = event.liveMode === "external" ? event.externalUrl : null;
  const stillAhead = upcoming && !ended;
  const startsAt = new Date(event.startsAt);

  return (
    <div className="rounded-2xl border border-line bg-wash p-6">
      <div className="flex items-start gap-4">
        {/* UTC on the server and first paint, then the viewer's zone. */}
        <div
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-phosphor/10 text-phosphor-ink"
          suppressHydrationWarning
        >
          <span className="text-[10px] font-bold uppercase">
            {startsAt.toLocaleString("en-US", {
              month: "short",
              ...(now ? {} : { timeZone: "UTC" }),
            })}
          </span>
          <span className="text-base font-bold leading-none">
            {now ? startsAt.getDate() : startsAt.getUTCDate()}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{event.title}</h3>
            <span className="font-mono text-[10px] uppercase tracking-wider text-phosphor-ink/80">
              {event.type.replace("_", " ")}
            </span>
            {live && <LiveDot />}
            {ended && (
              <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                Ended
              </span>
            )}
          </div>

          {event.description && (
            <p className="mt-1 text-sm text-ink-soft">{event.description}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              <LocalTime value={event.startsAt} />
            </span>
            {event.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {event.location}
              </span>
            )}
            {event.hostName && <span>Hosted by {event.hostName}</span>}
            {stillAhead && (
              <Link
                href={`/api/events/${event.id}/ics`}
                className="text-ink-faint underline underline-offset-2 hover:text-ink"
              >
                Add to calendar
              </Link>
            )}
            {event.recordingUrl && (!upcoming || ended) && (
              <a
                href={event.recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-phosphor-ink hover:underline"
              >
                Watch recording →
              </a>
            )}
          </div>

          {(joinable || stillAhead) && (
            <div className="mt-4">
              {hosted ? (
                joinable ? (
                  <ButtonLink
                    href={`/dashboard/events/${event.id}/live`}
                    size="sm"
                  >
                    <Video className="h-4 w-4" />
                    {live ? "Join now" : "Join webinar"}
                  </ButtonLink>
                ) : (
                  <p className="text-xs text-ink-faint">
                    Opens 15 min before
                    {now && <> · {relativeTime(event.startsAt, now)}</>}
                  </p>
                )
              ) : externalUrl ? (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-phosphor-ink hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Join
                </a>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
