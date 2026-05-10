"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  saveAssignment,
  deleteAssignment,
  type AssignmentInput,
} from "./actions";

type Cohort = { id: string; name: string };
type Lesson = { id: string; title: string; module_id: string };
type Module = { id: string; cohort_id: string | null; title: string; week: number };

function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  // datetime-local needs YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

export function AssignmentForm({
  initial,
  cohorts,
  modules,
  lessons,
}: {
  initial: AssignmentInput;
  cohorts: Cohort[];
  modules: Module[];
  lessons: Lesson[];
}) {
  const router = useRouter();
  const [a, setA] = useState<AssignmentInput>(initial);
  const [dueLocal, setDueLocal] = useState(toLocalInput(initial.due_at));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Filter lessons to those in selected cohort.
  const moduleIdsInCohort = new Set(
    modules.filter((m) => m.cohort_id === a.cohort_id).map((m) => m.id),
  );
  const lessonsInCohort = lessons.filter((l) =>
    moduleIdsInCohort.has(l.module_id),
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        await saveAssignment({
          ...a,
          due_at: fromLocalInput(dueLocal),
        });
        router.push("/mentor/assignments");
        router.refresh();
      } catch (err: any) {
        setError(err.message);
      }
    });
  }

  function onDelete() {
    if (!a.id) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteAssignment(a.id!);
        router.push("/mentor/assignments");
        router.refresh();
      } catch (err: any) {
        setError(err.message);
        setConfirmDelete(false);
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          required
          value={a.title}
          onChange={(e) => setA({ ...a, title: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="description">Description / instructions</Label>
        <Textarea
          id="description"
          rows={6}
          value={a.description ?? ""}
          onChange={(e) => setA({ ...a, description: e.target.value })}
          placeholder="What students need to do, deliverables, format, examples…"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Cohort</Label>
          <Select
            value={a.cohort_id}
            onChange={(e) =>
              setA({ ...a, cohort_id: e.target.value, lesson_id: null })
            }
            required
          >
            <option value="">— Select cohort —</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Lesson (optional)</Label>
          <Select
            value={a.lesson_id ?? ""}
            onChange={(e) =>
              setA({ ...a, lesson_id: e.target.value || null })
            }
            disabled={!a.cohort_id}
          >
            <option value="">— Standalone —</option>
            {lessonsInCohort.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="due">Due date (optional)</Label>
        <Input
          id="due"
          type="datetime-local"
          value={dueLocal}
          onChange={(e) => setDueLocal(e.target.value)}
        />
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
        <div>
          {a.id && (
            <Button
              type="button"
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              Delete assignment
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.back()}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : a.id ? "Save changes" : "Publish"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete assignment?"
        description={
          <>
            <p>
              <span className="text-white">{a.title}</span> and any submissions
              will be removed.
            </p>
            <p className="mt-2 text-amber-300/80">This cannot be undone.</p>
          </>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => !pending && setConfirmDelete(false)}
      />
    </form>
  );
}
