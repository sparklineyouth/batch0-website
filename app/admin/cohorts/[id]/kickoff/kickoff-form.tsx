"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  DEFAULT_AGENDA,
  DEFAULT_CHECKLIST,
  DEFAULT_NOTE,
  type KickoffAgendaItem,
  type KickoffChecklistItem,
} from "@/lib/kickoff";
import { saveKickoff, type KickoffInput } from "./actions";

const MAX_ROWS = 12;

/**
 * The kickoff editor.
 *
 * Every field is an override: leave it empty and the student sees the
 * built-in default, which is spelled out in the placeholder so an admin can
 * see what they'd be replacing before they replace it. That's what makes
 * "reset this back" the same gesture as "clear the box".
 */
export function KickoffForm({
  initial,
  defaultHeadline,
}: {
  initial: KickoffInput;
  /** What the heading falls back to — usually the formatted start date. */
  defaultHeadline: string;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function set<K extends keyof KickoffInput>(key: K, value: KickoffInput[K]) {
    setOkMsg(undefined);
    setV((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await saveKickoff(v);
        setOkMsg("Saved. Students see this on their Kickoff page.");
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  const agenda = v.agenda;
  const checklist = v.checklist;

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <div>
          <Label>Heading</Label>
          <Input
            value={v.headline}
            onChange={(e) => set("headline", e.target.value)}
            placeholder={`Default: ${defaultHeadline}`}
          />
        </div>
        <div>
          <Label>Intro</Label>
          <Textarea
            rows={3}
            value={v.intro}
            onChange={(e) => set("intro", e.target.value)}
            placeholder="Default: the standard 'kickoff is day one' paragraph."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Time</Label>
            <Input
              value={v.time_label}
              onChange={(e) => set("time_label", e.target.value)}
              placeholder="6:00 PM ET"
            />
            <p className="mt-1 text-xs text-ink-faint">
              Free text — write it exactly as students should read it.
            </p>
          </div>
          <div>
            <Label>Where</Label>
            <Input
              value={v.location_label}
              onChange={(e) => set("location_label", e.target.value)}
              placeholder="Zoom"
            />
          </div>
        </div>
        <div>
          <Label>Join link</Label>
          <Input
            value={v.join_url}
            onChange={(e) => set("join_url", e.target.value)}
            placeholder="https://…"
          />
          <p className="mt-1 text-xs text-ink-faint">
            Shown as a button. Must be a full https:// URL. Leave empty until
            you have the real link — no button appears without one.
          </p>
        </div>
      </section>

      <RowSection
        title="What happens on kickoff day"
        hint="Leave every row empty to use the standard four."
        count={agenda.length}
        onAdd={() => set("agenda", [...agenda, { title: "", body: "" }])}
        onReset={() => set("agenda", [])}
        emptyLabel={`Using the default ${DEFAULT_AGENDA.length} items.`}
      >
        {agenda.map((row, i) => (
          <RowCard
            key={i}
            index={i}
            onRemove={() =>
              set(
                "agenda",
                agenda.filter((_, j) => j !== i),
              )
            }
          >
            <Input
              value={row.title}
              onChange={(e) =>
                set("agenda", replaceAt(agenda, i, { ...row, title: e.target.value }))
              }
              placeholder="Title — e.g. The course"
            />
            <Textarea
              rows={2}
              className="mt-2"
              value={row.body}
              onChange={(e) =>
                set("agenda", replaceAt(agenda, i, { ...row, body: e.target.value }))
              }
              placeholder="What it means for them."
            />
          </RowCard>
        ))}
      </RowSection>

      <RowSection
        title="Before kickoff"
        hint="The checklist in the sidebar. Links can be in-app paths (/dashboard/team) or full https:// URLs."
        count={checklist.length}
        onAdd={() =>
          set("checklist", [...checklist, { label: "", href: "" }])
        }
        onReset={() => set("checklist", [])}
        emptyLabel={`Using the default ${DEFAULT_CHECKLIST.length} links.`}
      >
        {checklist.map((row, i) => (
          <RowCard
            key={i}
            index={i}
            onRemove={() =>
              set(
                "checklist",
                checklist.filter((_, j) => j !== i),
              )
            }
          >
            <Input
              value={row.label}
              onChange={(e) =>
                set(
                  "checklist",
                  replaceAt(checklist, i, { ...row, label: e.target.value }),
                )
              }
              placeholder="Label — e.g. Link Discord and meet your cohort"
            />
            <Input
              className="mt-2 font-mono text-xs"
              value={row.href}
              onChange={(e) =>
                set(
                  "checklist",
                  replaceAt(checklist, i, { ...row, href: e.target.value }),
                )
              }
              placeholder="/dashboard/community"
            />
          </RowCard>
        ))}
      </RowSection>

      <section>
        <Label>Sidebar note</Label>
        <Textarea
          rows={3}
          value={v.note}
          onChange={(e) => set("note", e.target.value)}
          placeholder={`Default: ${DEFAULT_NOTE}`}
        />
      </section>

      {error && <FieldError>{error}</FieldError>}
      {okMsg && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{okMsg}</p>
      )}
      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save kickoff"}
        </Button>
      </div>
    </div>
  );
}

function replaceAt<T>(rows: T[], index: number, next: T): T[] {
  return rows.map((r, i) => (i === index ? next : r));
}

function RowSection({
  title,
  hint,
  count,
  emptyLabel,
  onAdd,
  onReset,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  emptyLabel: string;
  onAdd: () => void;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          <p className="mt-1 max-w-lg text-xs text-ink-faint">{hint}</p>
        </div>
        {count > 0 && (
          <Button variant="ghost" size="sm" onClick={onReset} type="button">
            Use the default
          </Button>
        )}
      </div>
      {count === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-faint">
          {emptyLabel}
        </p>
      ) : (
        <div className="mt-4 space-y-3">{children}</div>
      )}
      {count < MAX_ROWS && (
        <Button
          variant="secondary"
          size="sm"
          type="button"
          className="mt-3"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          {count === 0 ? "Write a custom list" : "Add row"}
        </Button>
      )}
    </section>
  );
}

function RowCard({
  index,
  onRemove,
  children,
}: {
  index: number;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-wash p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove row ${index + 1}`}
          className="p-1 text-ink-faint hover:text-red-700 dark:hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
