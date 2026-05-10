import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CalendarDays, MapPin, Video } from "lucide-react";

export const metadata = { title: "Events · SparkLine" };

export default async function StudentEventsPage() {
  await requireUser();
  const supabase = createClient();

  const now = new Date().toISOString();
  const [{ data: upcoming }, { data: past }] = await Promise.all([
    supabase
      .from("events")
      .select("*")
      .gte("starts_at", now)
      .order("starts_at", { ascending: true }),
    supabase
      .from("events")
      .select("*")
      .lt("starts_at", now)
      .order("starts_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Events</h1>
      <p className="mt-1 text-sm text-white/50">
        Demo Day, office hours, workshops.
      </p>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-spark">
          Upcoming
        </h2>
        {(upcoming?.length ?? 0) === 0 ? (
          <Card>
            <p className="text-sm text-white/50">Nothing scheduled yet.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {(upcoming ?? []).map((e: any) => (
              <EventCard key={e.id} event={e} upcoming />
            ))}
          </div>
        )}
      </section>

      {(past?.length ?? 0) > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
            Past
          </h2>
          <div className="space-y-3">
            {(past ?? []).map((e: any) => (
              <EventCard key={e.id} event={e} upcoming={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EventCard({ event, upcoming }: { event: any; upcoming: boolean }) {
  const startsAt = new Date(event.starts_at);
  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-spark/10 text-spark">
          <span className="text-[10px] font-bold uppercase">
            {startsAt.toLocaleString("en-US", { month: "short" })}
          </span>
          <span className="text-base font-bold leading-none">
            {startsAt.getDate()}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-base font-semibold text-white">
              {event.title}
            </h3>
            <span className="text-[10px] uppercase tracking-wider text-spark/80">
              {event.type.replace("_", " ")}
            </span>
          </div>
          {event.description && (
            <p className="mt-1 text-sm text-white/60">{event.description}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" />
              {startsAt.toLocaleString()}
            </span>
            {event.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {event.location}
              </span>
            )}
            {event.zoom_url && upcoming && (
              <a
                href={event.zoom_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-spark hover:underline"
              >
                <Video className="h-3.5 w-3.5" />
                Join Zoom
              </a>
            )}
            {event.recording_url && !upcoming && (
              <a
                href={event.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-spark hover:underline"
              >
                Watch recording →
              </a>
            )}
            {upcoming && (
              <a
                href={`/api/events/${event.id}/ics`}
                className="text-white/50 hover:text-white"
              >
                Add to calendar
              </a>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
