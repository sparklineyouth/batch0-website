"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/call-stage";
import { getActionError } from "@/lib/action-error";
import { saveEvent } from "@/app/admin/events/actions";
import { canJoin, joinState, relativeTime, type LiveEvent } from "@/lib/live";
import { Plus, Pencil, Video, Radio } from "lucide-react";

type Webinar = LiveEvent & { visibility: string };

const DURATIONS = [30, 45, 60, 90, 120];

const VISIBILITIES = [
  {
    value: "enrolled",
    label: "Enrolled students",
    hint: "Everyone in the cohort sees it on their events page.",
  },
  {
    value: "staff",
    label: "Staff only — rehearsal",
    hint: "Nobody but staff can see or join. Use this to test before going live to students.",
  },
  { value: "public", label: "Public", hint: "Anyone signed in can join." },
];

/**
 * Schedule and review webinars.
 *
 * The form deliberately asks less than the full event editor: a webinar needs
 * a title, a time, a length, and who may watch. Everything else an event can
 * carry — cohort, location, recording URL, Discord cross-post — is still one
 * click away in /admin/events, and pre-filling this form with all of it would
 * bury the four fields that actually matter.
 */
export function WebinarsManager({
  live,
  upcoming,
  past,
  cohorts,
}: {
  live: Webinar[];
  upcoming: Webinar[];
  past: Webinar[];
  cohorts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function schedule(draft: {
    title: string;
    description: string;
    startsLocal: string;
    durationMinutes: number;
    visibility: string;
    cohortId: string | null;
    notify: boolean;
  }) {
    setError(undefined);
    const startsAt = new Date(draft.startsLocal);
    if (Number.isNaN(startsAt.getTime())) {
      setError("That start time isn't valid.");
      return;
    }
    start(async () => {
      try {
        await saveEvent(
          {
            cohort_id: draft.cohortId,
            type: "workshop",
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
            Schedule one as <strong>Staff only</strong> first — you can walk
            through the whole thing without a single student seeing it.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {live.length > 0 && (
            <Section label="Live now" accent>
              {live.map((w) => (
                <Row key={w.id} webinar={w} />
              ))}
            </Section>
          )}
          {upcoming.length > 0 && (
            <Section label="Upcoming">
              {upcoming.map((w) => (
                <Row key={w.id} webinar={w} />
              ))}
            </Section>
          )}
          {past.length > 0 && (
            <Section label="Past">
              {past.map((w) => (
                <Row key={w.id} webinar={w} />
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

function Row({ webinar: w }: { webinar: Webinar }) {
  // Server-rendered, so this is the request's clock rather than the viewer's.
  // Good enough for a coarse status chip; LocalTime handles the exact time.
  const state = joinState(w.startsAt, w.endsAt);
  const joinable = canJoin(state);

  return (
    <div className="rounded-2xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{w.title}</h3>
            {state === "live" && <LiveDot />}
            {w.visibility === "staff" && (
              <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                staff only
              </span>
            )}
          </div>
          {w.description && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-soft">
              {w.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <LocalTime value={w.startsAt} mode="datetime-short" />
            {state === "early" && <span>{relativeTime(w.startsAt)}</span>}
            {!w.roomName && (
              <span className="text-amber-600 dark:text-amber-400">
                no room yet — re-save to create one
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

        <div className="flex shrink-0 items-center gap-2">
          {joinable && w.roomName && (
            <ButtonLink size="sm" href={`/dashboard/events/${w.id}/live`}>
              <Video className="h-4 w-4" />
              {state === "live" ? "Join now" : "Open"}
            </ButtonLink>
          )}
          <Link
            href="/admin/events"
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

function ScheduleForm({
  cohorts,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  cohorts: { id: string; name: string }[];
  onSubmit: (d: {
    title: string;
    description: string;
    startsLocal: string;
    durationMinutes: number;
    visibility: string;
    cohortId: string | null;
    notify: boolean;
  }) => void;
  onCancel: () => void;
  pending: boolean;
  error?: string;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsLocal, setStartsLocal] = useState(defaultStart());
  const [duration, setDuration] = useState(60);
  // Staff-only by default: the safe rehearsal, one dropdown away from going
  // live to students. Defaulting the other way makes the first mistake public.
  const [visibility, setVisibility] = useState("staff");
  const [cohortId, setCohortId] = useState<string>(cohorts[0]?.id ?? "");
  const [notify, setNotify] = useState(false);

  const hint = VISIBILITIES.find((v) => v.value === visibility)?.hint;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">Schedule a webinar</h2>

      <div>
        <Label>Title</Label>
        <Input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Fundraising 101"
        />
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Starts</Label>
          <Input
            type="datetime-local"
            value={startsLocal}
            onChange={(e) => setStartsLocal(e.target.value)}
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
              : "Sends an announcement now, with a link that opens 15 minutes before the start."}
          </span>
        </span>
      </label>

      <p className="rounded-md border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
        A private room is created when you save, and expires two hours after the
        end. Only you get camera and mic — students watch, ask questions beside
        the video, and can&rsquo;t see each other or how many are here.
      </p>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex gap-2 pt-1">
        <Button
          disabled={pending || !title.trim()}
          onClick={() =>
            onSubmit({
              title,
              description,
              startsLocal,
              durationMinutes: duration,
              visibility,
              cohortId: cohortId || null,
              notify: visibility === "staff" ? false : notify,
            })
          }
        >
          {pending ? "Creating the room…" : "Schedule webinar"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The next round hour, an hour out — never a time already past. */
function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
