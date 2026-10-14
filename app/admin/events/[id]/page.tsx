import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import { EventRecordings } from "@/components/live/recording-player";
import { listAssets, listAttendance, listSpeakers, signAssets } from "@/lib/webinar-data";
import { listQuestionsForEvent } from "@/lib/webinar-questions";
import { formatBytes } from "@/lib/webinars";
import { presentHosts } from "@/lib/live-rooms";
import { PEER_TIMEOUT_MS } from "@/lib/live-signal";
import { joinNames } from "@/lib/live";
import { adminGroup, EVENT_TYPE_LABEL, isEventType, isUuid, roomActionLabel } from "@/lib/event-form";
import { LiveControls } from "../live-controls";
import { FileDown, Pencil, Video } from "lucide-react";

export const metadata = {
  title: "Event · Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** What happened at an event: status, who came, what they asked, the recording. */
export default async function AdminEventPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  await requirePermission("events.manage");
  if (!isUuid(id)) notFound();

  const admin = createAdminClient();
  const { data: event } = await admin
    .from("events")
    .select(
      "id, title, type, cohort_id, starts_at, ends_at, visibility, live_mode, recording_url, live_started_at, live_ended_at, cohort:cohorts(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!event) notFound();
  const ev = event as any;
  const hosted = ev.live_mode === "hosted" || ev.live_mode === "premiere";
  const now = new Date();
  const timing = {
    startsAt: ev.starts_at as string,
    endsAt: (ev.ends_at as string | null) ?? null,
    liveStartedAt: (ev.live_started_at as string | null) ?? null,
    liveEndedAt: (ev.live_ended_at as string | null) ?? null,
  };

  const [attendance, questions, assets, speakers, hosts] = await Promise.all([
    listAttendance(id),
    listQuestionsForEvent(id),
    listAssets(id, ["deck", "handout"]),
    listSpeakers(id, true),
    hosted ? presentHosts(id, PEER_TIMEOUT_MS) : Promise.resolve(null),
  ]);
  const files = await signAssets(assets, 60 * 60);

  const onAirIds = (hosts ?? []).map((h) => h.userId);
  const group = adminGroup(timing, now, onAirIds.length > 0);
  const action = hosted ? roomActionLabel(group, onAirIds.length > 0, timing, now) : null;
  const hostNames = attendance.filter((a) => onAirIds.includes(a.userId)).map((a) => a.name);

  const viewers = attendance.filter((a) => a.role !== "host");
  const hostRows = attendance.filter((a) => a.role === "host");
  const attended = viewers.filter((a) => a.minutes >= 1);
  const type: unknown = ev.type;
  const typeLabel = isEventType(type) ? EVENT_TYPE_LABEL[type] : "Event";
  const cohort = Array.isArray(ev.cohort) ? ev.cohort[0] : ev.cohort;
  const audience =
    ev.visibility === "staff"
      ? "Staff only"
      : ev.visibility === "public"
        ? "Everyone"
        : (cohort?.name ?? "Cohort");

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/events" className="text-sm text-phosphor-ink hover:underline">
        ← Events
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 font-display text-3xl text-ink">
            {ev.title}
            {group === "live" && <LiveDot />}
          </h1>
          <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-ink-soft">
            <LocalTime value={ev.starts_at} mode="datetime-short" />
            <span>{typeLabel}</span>
            <span>{audience}</span>
            {ev.live_started_at && (
              <span>
                Went live <LocalTime value={ev.live_started_at} mode="time" />
              </span>
            )}
            {ev.live_ended_at && (
              <span>
                Ended <LocalTime value={ev.live_ended_at} mode="time" />
              </span>
            )}
          </p>
          {hostNames.length > 0 && (
            <p className="mt-1 text-sm text-phosphor-ink">{joinNames(hostNames)} hosting</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {action && (
            <ButtonLink size="sm" href={`/dashboard/events/${ev.id}/live`}>
              <Video className="h-4 w-4" /> {action}
            </ButtonLink>
          )}
          {hosted && (
            <LiveControls
              eventId={ev.id}
              startsAt={ev.starts_at}
              endsAt={ev.ends_at ?? null}
              liveStartedAt={ev.live_started_at ?? null}
              liveEndedAt={ev.live_ended_at ?? null}
              now={now.toISOString()}
            />
          )}
          <ButtonLink size="sm" variant="secondary" href={`/admin/events?edit=${ev.id}`}>
            <Pencil className="h-4 w-4" /> Edit
          </ButtonLink>
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-3 gap-4 border-y border-line py-4">
        <Stat label="Attended" value={String(attended.length)} />
        <Stat
          label="Median min"
          value={attended.length ? String(median(attended.map((a) => a.minutes))) : "—"}
        />
        <Stat label="Questions" value={String(questions.length)} />
      </dl>

      {(hosted || ev.recording_url) && (
        <Section id="recording" title="Recording">
          {hosted && (
            <EventRecordings
              eventId={ev.id}
              emptyText={ev.recording_url ? undefined : "No recording yet."}
            />
          )}
          {ev.recording_url && (
            <a
              href={ev.recording_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-phosphor-ink hover:underline"
            >
              Recording link →
            </a>
          )}
        </Section>
      )}

      {files.length > 0 && (
        <Section title="Slides">
          <ul className="space-y-2">
            {files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink-soft">
                  {f.filename}{" "}
                  <span className="text-xs text-ink-faint">{formatBytes(f.sizeBytes)}</span>
                </span>
                {f.url && (
                  <a
                    href={f.url}
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-phosphor-ink hover:underline"
                  >
                    <FileDown className="h-3.5 w-3.5" /> Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {speakers.length > 0 && (
        <Section title="Speakers">
          <ul className="space-y-1 text-sm text-ink-soft">
            {speakers.map((sp) => (
              <li key={sp.id}>
                {sp.name}
                {sp.title ? <span className="text-ink-faint"> · {sp.title}</span> : null}
                {!sp.userId && <span className="text-xs text-ink-faint"> · invite not used yet</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Who came (${attendance.length})`}>
        {attendance.length === 0 ? (
          <p className="text-sm text-ink-faint">Nobody yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-faint">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Joined</th>
                  <th className="pb-2 font-medium">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {[...hostRows, ...viewers].map((a) => (
                  <tr key={a.userId} className="border-b border-line/50">
                    <td className="py-2 text-ink-soft">
                      {a.name}
                      {a.role === "host" && <span className="ml-2 text-xs text-phosphor-ink">host</span>}
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
      </Section>

      {questions.length > 0 && (
        <Section title="Questions">
          <ul className="space-y-3">
            {questions.map((q) => (
              <li key={q.id} className="border-b border-line/50 pb-3 last:border-0">
                <p className="text-sm text-ink-soft">{q.body}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {q.askerName} · <LocalTime value={q.createdAt} mode="time" /> · {q.status}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-8 scroll-mt-20">
      <h2 className="mb-3 font-display text-xl text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-1 font-display text-2xl text-ink">{value}</dd>
    </div>
  );
}

/** Middle value (lower of the two middles). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}
