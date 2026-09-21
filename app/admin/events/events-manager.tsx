"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { normalizeDisplayViewers } from "@/lib/live";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { saveEvent, deleteEvent, type EventInput } from "./actions";
import { fetchWebinarExtras, saveSpeakers } from "./webinar-actions";
import {
  WebinarFields,
  type WebinarFieldsValue,
} from "./webinar-fields";
import { Plus, Pencil, Trash2 } from "lucide-react";

type Cohort = { id: string; name: string };
type EventRow = EventInput & { id: string };

const TYPES = [
  { value: "demo_day", label: "Demo Day" },
  { value: "office_hours", label: "Office hours" },
  { value: "workshop", label: "Workshop" },
  { value: "webinar", label: "Webinar" },
  { value: "other", label: "Other" },
];

const VISIBILITIES = [
  { value: "enrolled", label: "Enrolled students only" },
  { value: "staff", label: "Staff only" },
  { value: "public", label: "Public" },
];

function toLocal(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocal(local: string): string {
  return new Date(local).toISOString();
}

/**
 * Default start for a new event: the coming Sunday at the next round hour —
 * today, only when today is already Sunday. Events run on Sundays, so
 * defaulting to right now just hands the admin a weekday to correct.
 */
function comingSundayStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  // getDay(): Sunday is 0. Roll forward to the next Sunday, staying on today
  // when today is already Sunday.
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d.toISOString();
}

/**
 * The webinar half of an event, as the form should first see it.
 *
 * Speakers and files are deliberately empty here rather than fetched: they
 * belong to an event that may not exist yet, and `WebinarFields` loads them
 * itself once it has an id. Seeding them from the list page would mean the
 * admin list query carrying every speaker bio and every file row for every
 * event on the calendar, to populate one form.
 */
function webinarInitialFor(e: EventInput): WebinarFieldsValue {
  return {
    audienceMode: e.audience_mode ?? "private",
    autoRecord: e.auto_record ?? false,
    autoShare: e.auto_share ?? false,
    liveMode: e.live_mode,
    premiereSeconds: null,
    // Stored as a timestamptz, edited as a `datetime-local` string. Converted
    // on the way in here and back on the way out in `submit`, exactly as
    // starts_at/ends_at already are — without this the input renders blank for
    // a saved value and writes an unparseable one back.
    qaOpensAt: e.qa_opens_at ? toLocal(e.qa_opens_at) : null,
    speakers: [],
    assets: [],
    // Nothing to load for a brand-new event, so it is "loaded" already. For an
    // existing one this flips true when fetchWebinarExtras lands, and until it
    // does the form will not touch the speaker list.
    speakersLoaded: !(e as EventInput & { id?: string }).id,
  };
}

export function EventsManager({
  events,
  cohorts,
}: {
  events: EventRow[];
  cohorts: Cohort[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<EventInput | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function save(e: EventInput, notify: boolean, w: WebinarFieldsValue) {
    setError(undefined);
    start(async () => {
      try {
        // The event first, because it is what a speaker row points at — and
        // because `saveEvent` is the call that MINTS the id for a brand-new
        // event. Saving speakers first would have nothing to attach them to.
        const id = await saveEvent(
          {
            ...e,
            audience_mode: w.audienceMode,
            auto_record: w.autoRecord,
            auto_share: w.autoShare,
            live_mode: w.liveMode,
            qa_opens_at: w.qaOpensAt,
          },
          notify,
        );

        // Speakers are a second write rather than part of the payload, because
        // they are their own table and the form edits them as a whole list.
        //
        // GUARDED ON `speakersLoaded`, and that guard is load-bearing:
        // `saveSpeakers` REPLACES the list, deleting any row not in what it is
        // handed. The form seeds speakers as an empty array and fills them from
        // the server a moment later, so saving in that window — or after the
        // seed request failed — would silently delete every guest speaker the
        // event already had. Skipping the write entirely is the safe answer:
        // the speakers stay exactly as they were.
        if (w.speakersLoaded)
        await saveSpeakers(
          id,
          w.speakers.map((sp, i) => ({
            id: sp.id,
            name: sp.name,
            title: sp.title || null,
            bio: sp.bio || null,
            email: sp.email || null,
            photoUrl: sp.photoUrl || null,
            linkUrl: sp.linkUrl || null,
            sortOrder: i,
          })),
        );

        setEditing(null);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function executeDelete() {
    if (!confirmDeleteId) return;
    setError(undefined);
    const id = confirmDeleteId;
    start(async () => {
      try {
        await deleteEvent(id);
        setConfirmDeleteId(null);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  if (editing) {
    return (
      <EventForm
        cohorts={cohorts}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSave={save}
        webinarInitial={webinarInitialFor(editing)}
        pending={pending}
        error={error}
      />
    );
  }

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button
          onClick={() =>
            setEditing({
              cohort_id: cohorts[0]?.id ?? null,
              type: "demo_day",
              title: "",
              description: "",
              starts_at: comingSundayStart(),
              ends_at: null,
              location: null,
              zoom_url: "",
              recording_url: null,
              visibility: "enrolled",
              live_mode: "external",
              display_viewer_count: null,
              daily_room_name: null,
              daily_room_url: null,
            })
          }
        >
          <Plus className="h-4 w-4" /> New event
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
            <th className="pb-3">Title</th>
            <th className="pb-3">Type</th>
            <th className="pb-3">Cohort</th>
            <th className="pb-3">Starts</th>
            <th className="pb-3">Visibility</th>
            <th className="pb-3"></th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-sm text-ink-faint">
                No events yet.
              </td>
            </tr>
          )}
          {events.map((e) => {
            const cohort = cohorts.find((c) => c.id === e.cohort_id);
            return (
            <tr key={e.id} className="border-b border-line last:border-0">
              <td className="py-3 text-ink">{e.title}</td>
              <td className="py-3 text-ink-soft">
                {e.type}
                {e.live_mode === "hosted" && (
                  <span className="ml-1.5 font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                    hosted
                  </span>
                )}
              </td>
              <td className="py-3 text-ink-soft">
                {cohort?.name ?? (e.cohort_id ? "—" : "Any")}
              </td>
              <td className="py-3 text-ink-soft">
                <LocalTime value={e.starts_at} />
              </td>
              <td className="py-3 text-ink-soft">{e.visibility}</td>
              <td className="py-3 text-right">
                <button
                  onClick={() => setEditing(e)}
                  className="p-1.5 text-ink-faint hover:text-ink"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(e.id)}
                  className="p-1.5 text-ink-faint hover:text-red-600 dark:hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete event?"
        description={<p>This event will be removed.</p>}
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDeleteId(null)}
      />
    </div>
  );
}

function EventForm({
  initial,
  cohorts,
  onCancel,
  onSave,
  pending,
  error,
  webinarInitial,
}: {
  initial: EventInput;
  cohorts: Cohort[];
  onCancel: () => void;
  onSave: (e: EventInput, notify: boolean, w: WebinarFieldsValue) => void;
  pending: boolean;
  error?: string;
  /** Speakers and files already attached. Empty for a new event. */
  webinarInitial: WebinarFieldsValue;
}) {
  const [e, setE] = useState<EventInput>(initial);
  const [w, setW] = useState<WebinarFieldsValue>(webinarInitial);

  // Speakers and files for an event that already exists.
  //
  // Fetched here rather than carried by the admin list query, which would
  // otherwise haul every speaker biography and every file row for every event
  // on the calendar to populate one form. Until it lands, `speakersLoaded`
  // stays false and `save` leaves the speaker list alone — see the note there.
  const eventId = (initial as EventInput & { id?: string }).id ?? null;
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    void fetchWebinarExtras(eventId)
      .then((extra) => {
        if (cancelled) return;
        setW((prev) => ({
          ...prev,
          speakersLoaded: true,
          speakers: extra.speakers.map((sp) => ({
            id: sp.id,
            name: sp.name,
            title: sp.title ?? "",
            bio: sp.bio ?? "",
            email: sp.email ?? "",
            photoUrl: sp.photoUrl ?? "",
            linkUrl: sp.linkUrl ?? "",
            claimed: !!sp.userId,
          })),
          assets: extra.assets
            .filter((a) => a.kind !== "recording")
            .map((a) => ({
              id: a.id,
              kind: a.kind as "deck" | "handout" | "premiere",
              storagePath: a.storagePath,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              durationSeconds: a.durationSeconds,
            })),
          premiereSeconds:
            extra.assets.find((a) => a.kind === "premiere")?.durationSeconds ??
            prev.premiereSeconds,
        }));
      })
      .catch(() => {
        // Left un-loaded on purpose. A failed seed must not become a save that
        // deletes the speakers it could not read.
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);
  const [startsLocal, setStartsLocal] = useState(toLocal(initial.starts_at));
  const [endsLocal, setEndsLocal] = useState(toLocal(initial.ends_at));
  const [notify, setNotify] = useState(false);

  function submit() {
    if (!e.title.trim()) return;
    onSave(
      {
        ...e,
        starts_at: fromLocal(startsLocal),
        ends_at: endsLocal ? fromLocal(endsLocal) : null,
      },
      notify,
      {
        ...w,
        // Back to an ISO timestamp for the column, mirroring starts_at/ends_at.
        qaOpensAt: w.qaOpensAt ? fromLocal(w.qaOpensAt) : null,
      },
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">
        {initial.id ? "Edit event" : "New event"}
      </h3>
      <div>
        <Label>Title</Label>
        <Input
          required
          value={e.title}
          onChange={(ev) => setE({ ...e, title: ev.target.value })}
        />
      </div>
      <div>
        <Label>Description</Label>
        <Textarea
          rows={3}
          value={e.description ?? ""}
          onChange={(ev) => setE({ ...e, description: ev.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Type</Label>
          <Select
            value={e.type}
            onChange={(ev) =>
              setE({ ...e, type: ev.target.value as EventInput["type"] })
            }
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Cohort (optional)</Label>
          <Select
            value={e.cohort_id ?? ""}
            onChange={(ev) =>
              setE({ ...e, cohort_id: ev.target.value || null })
            }
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Starts at</Label>
          <Input
            type="datetime-local"
            value={startsLocal}
            onChange={(ev) => setStartsLocal(ev.target.value)}
          />
        </div>
        <div>
          <Label>Ends at (optional)</Label>
          <Input
            type="datetime-local"
            value={endsLocal}
            onChange={(ev) => setEndsLocal(ev.target.value)}
          />
        </div>
      </div>
      <div>
        <Label>Location</Label>
        <Input
          value={e.location ?? ""}
          onChange={(ev) => setE({ ...e, location: ev.target.value })}
          placeholder="Virtual / address"
        />
      </div>

      {/*
        Hosting is now a three-way choice (external / hosted / premiere), and
        it lives inside WebinarFields with the rest of the webinar settings.
        This toggle stays for the simple case — an admin adding office hours
        does not want a premiere picker — and the two are kept in step by
        reading and writing the SAME `w.liveMode`, so there is one source of
        truth rather than a toggle and a segmented control that can disagree.
      */}
      <Toggle
        label="Host the video on batch0"
        description={
          w.liveMode !== "external"
            ? "Students join at batch0.org. Only you get camera and mic — they watch, and can't see how many others are here."
            : "Off: paste an external link below instead. Students leave the site to join it."
        }
        checked={w.liveMode !== "external"}
        onChange={(on) => {
          const mode = on ? "hosted" : "external";
          setW({ ...w, liveMode: mode });
          setE({ ...e, live_mode: mode });
        }}
      />

      <WebinarFields
        value={w}
        onChange={(next) => {
          setW(next);
          // Mirrored onto the event draft so the branch below — and the
          // payload `submit` builds — agree with the picker.
          if (next.liveMode !== e.live_mode) {
            setE({ ...e, live_mode: next.liveMode });
          }
        }}
        eventId={eventId}
        // From the LIVE form state, not the saved row: an admin who moves the
        // start is usually moving it because of what the schedule line says,
        // and a line computed from disk would keep describing the old plan.
        startsAt={startsLocal ? fromLocal(startsLocal) : null}
        disabled={pending}
      />

      {w.liveMode === "external" ? (
        <div>
          <Label>Zoom URL</Label>
          <Input
            type="url"
            value={e.zoom_url ?? ""}
            onChange={(ev) => setE({ ...e, zoom_url: ev.target.value })}
            placeholder="https://zoom.us/…"
          />
        </div>
      ) : (
        <p className="rounded-md border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
          {initial.daily_room_name ? (
            <>
              Room ready. Students join at{" "}
              <code className="text-phosphor-ink">
                /dashboard/events/{initial.id}/live
              </code>{" "}
              from 15 minutes before the start.
            </>
          ) : (
            <>
              A private room is created when you save. It expires two hours
              after the event ends, so nothing is left open.
            </>
          )}
        </p>
      )}
      {e.live_mode !== "external" && (
        <div>
          <Label>Shown attendees (optional)</Label>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={e.display_viewer_count ?? ""}
            onChange={(ev) =>
              setE({
                ...e,
                display_viewer_count: normalizeDisplayViewers(ev.target.value),
              })
            }
            placeholder="Leave blank to hide the count"
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            {e.display_viewer_count !== null &&
            e.display_viewer_count !== undefined
              ? `Everyone watching sees “${e.display_viewer_count.toLocaleString()} watching,” in place of the hidden headcount.`
              : "Blank keeps turnout hidden from the audience. Set a number to announce that many watching to everyone."}
          </p>
        </div>
      )}
      <div>
        <Label>Recording URL (after the event)</Label>
        <Input
          type="url"
          value={e.recording_url ?? ""}
          onChange={(ev) => setE({ ...e, recording_url: ev.target.value })}
        />
      </div>
      <div>
        <Label>Visibility</Label>
        <Select
          value={e.visibility}
          onChange={(ev) =>
            setE({ ...e, visibility: ev.target.value as EventInput["visibility"] })
          }
        >
          {VISIBILITIES.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      <Toggle
        label="Notify enrolled students"
        description="Sends an in-app notification + email to everyone in the chosen cohort."
        checked={notify}
        onChange={setNotify}
      />

      {error && <FieldError>{error}</FieldError>}

      <div className="flex gap-2 pt-2">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save event"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
