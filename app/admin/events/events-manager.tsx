"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveEvent, deleteEvent, type EventInput } from "./actions";
import { Plus, Pencil, Trash2 } from "lucide-react";

type Cohort = { id: string; name: string };
type EventRow = EventInput & { id: string };

const TYPES = [
  { value: "demo_day", label: "Demo Day" },
  { value: "office_hours", label: "Office hours" },
  { value: "workshop", label: "Workshop" },
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

  function save(e: EventInput, notify: boolean) {
    setError(undefined);
    start(async () => {
      try {
        await saveEvent(e, notify);
        setEditing(null);
        router.refresh();
      } catch (err: any) {
        setError(err.message);
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
        setError(err.message);
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
              starts_at: new Date().toISOString(),
              ends_at: null,
              location: null,
              zoom_url: "",
              recording_url: null,
              visibility: "enrolled",
            })
          }
        >
          <Plus className="h-4 w-4" /> New event
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
            <th className="pb-3">Title</th>
            <th className="pb-3">Type</th>
            <th className="pb-3">Starts</th>
            <th className="pb-3">Visibility</th>
            <th className="pb-3"></th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-sm text-white/50">
                No events yet.
              </td>
            </tr>
          )}
          {events.map((e) => (
            <tr key={e.id} className="border-b border-white/5 last:border-0">
              <td className="py-3 text-white">{e.title}</td>
              <td className="py-3 text-white/60">{e.type}</td>
              <td className="py-3 text-white/70">
                {new Date(e.starts_at).toLocaleString()}
              </td>
              <td className="py-3 text-white/60">{e.visibility}</td>
              <td className="py-3 text-right">
                <button
                  onClick={() => setEditing(e)}
                  className="p-1.5 text-white/50 hover:text-white"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(e.id)}
                  className="p-1.5 text-white/50 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

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
}: {
  initial: EventInput;
  cohorts: Cohort[];
  onCancel: () => void;
  onSave: (e: EventInput, notify: boolean) => void;
  pending: boolean;
  error?: string;
}) {
  const [e, setE] = useState<EventInput>(initial);
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Location</Label>
          <Input
            value={e.location ?? ""}
            onChange={(ev) => setE({ ...e, location: ev.target.value })}
            placeholder="Virtual / address"
          />
        </div>
        <div>
          <Label>Zoom URL</Label>
          <Input
            type="url"
            value={e.zoom_url ?? ""}
            onChange={(ev) => setE({ ...e, zoom_url: ev.target.value })}
            placeholder="https://zoom.us/…"
          />
        </div>
      </div>
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
