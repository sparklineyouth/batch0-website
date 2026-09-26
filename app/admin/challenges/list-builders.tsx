"use client";
import { Plus, Trash2 } from "lucide-react";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  MAX_FAQ,
  MAX_RESOURCES,
  MAX_SCHEDULE,
  newItemId,
  type FaqItem,
  type ResourceLink,
  type ScheduleItem,
} from "@/lib/challenges-shared";
import { IconBtn } from "./challenge-question-builder";

export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-2 text-[13px] font-medium text-ink hover:border-ink/30"
    >
      <Plus className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

/** Extra timeline milestones: kickoff call, office hours, demo day. */
export function ScheduleBuilder({
  value,
  onChange,
}: {
  value: ScheduleItem[];
  onChange: (v: ScheduleItem[]) => void;
}) {
  const update = (i: number, patch: Partial<ScheduleItem>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      {value.map((s, i) => (
        <div key={s.id} className="grid gap-2 rounded-lg border border-line bg-paper p-3 sm:grid-cols-[13rem_minmax(0,1fr)_auto]">
          <Input
            type="datetime-local"
            aria-label="When"
            value={isoToLocalInput(s.at)}
            onChange={(e) => update(i, { at: localInputToIso(e.target.value) ?? "" })}
          />
          <div className="space-y-2">
            <Input aria-label="Milestone" value={s.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Kickoff call" />
            <Input aria-label="Details" value={s.detail} onChange={(e) => update(i, { detail: e.target.value })} placeholder="Details (optional)" />
            <Input aria-label="Link" value={s.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="https://… link (optional)" />
          </div>
          <IconBtn label="Remove milestone" danger onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      ))}
      {value.length < MAX_SCHEDULE && (
        <AddButton onClick={() => onChange([...value, { id: newItemId(), at: "", label: "", detail: "", url: "" }])}>
          Add milestone
        </AddButton>
      )}
    </div>
  );
}

export function FaqBuilder({ value, onChange }: { value: FaqItem[]; onChange: (v: FaqItem[]) => void }) {
  const update = (i: number, patch: Partial<FaqItem>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      {value.map((f, i) => (
        <div key={f.id} className="flex gap-2 rounded-lg border border-line bg-paper p-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Input aria-label="Question" value={f.q} onChange={(e) => update(i, { q: e.target.value })} placeholder="Can I work in a team?" />
            <Textarea aria-label="Answer" rows={2} value={f.a} onChange={(e) => update(i, { a: e.target.value })} placeholder="Yes — up to 4 people. List them on the form." />
          </div>
          <IconBtn label="Remove question" danger onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      ))}
      {value.length < MAX_FAQ && (
        <AddButton onClick={() => onChange([...value, { id: newItemId(), q: "", a: "" }])}>Add FAQ</AddButton>
      )}
    </div>
  );
}

export function ResourceBuilder({
  value,
  onChange,
}: {
  value: ResourceLink[];
  onChange: (v: ResourceLink[]) => void;
}) {
  const update = (i: number, patch: Partial<ResourceLink>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      {value.map((r, i) => (
        <div key={r.id} className="flex gap-2 rounded-lg border border-line bg-paper p-3">
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="sr-only">Label</Label>
              <Input aria-label="Label" value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Starter template" />
            </div>
            <Input aria-label="URL" value={r.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="https://…" />
            <Input aria-label="Description" className="sm:col-span-2" value={r.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="What it's for (optional)" />
          </div>
          <IconBtn label="Remove link" danger onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      ))}
      {value.length < MAX_RESOURCES && (
        <AddButton onClick={() => onChange([...value, { id: newItemId(), label: "", url: "", description: "" }])}>Add link</AddButton>
      )}
    </div>
  );
}
