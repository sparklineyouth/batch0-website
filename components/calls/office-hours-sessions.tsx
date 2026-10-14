import { ExternalLink } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import type { OfficeHoursSession } from "@/lib/office-hours";

/**
 * Office hours booked before they were retired and still ahead (see
 * lib/office-hours.ts). Renders nothing once the last one has ended.
 */
export function OfficeHoursSessions({
  sessions,
  className = "",
}: {
  sessions: OfficeHoursSession[];
  className?: string;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className={className} aria-labelledby="office-hours-heading">
      <h2 id="office-hours-heading" className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
        Office hours already booked
      </h2>
      <p className="mt-1 text-xs text-ink-faint">Booked before office hours ended. They still go ahead.</p>
      <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                <LocalTime value={s.startsAt} mode="datetime-short" /> · with {s.withName}
              </p>
              {s.topic && <p className="mt-0.5 truncate text-xs text-ink-faint">{s.topic}</p>}
              {/* Plain text only: these were free-form fields on the old slot form. */}
              {s.meetingText && (
                <p className="mt-1 break-words text-xs text-ink-soft">Meeting: {s.meetingText}</p>
              )}
              {s.notes && <p className="mt-1 whitespace-pre-line break-words text-xs text-ink-soft">{s.notes}</p>}
            </div>
            {s.joinUrl ? (
              <a
                href={s.joinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink underline underline-offset-4"
              >
                Join <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <span className="text-xs text-ink-faint">
                {s.notes || s.meetingText ? "No join link; see the details" : "No meeting link"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
