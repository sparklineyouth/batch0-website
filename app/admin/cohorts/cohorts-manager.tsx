"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveCohort, deleteCohort, type CohortInput } from "./actions";
import { Pencil, Trash2, Plus, Activity } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Cohort = CohortInput & {
  id: string;
  enrollments?: { count: number }[];
};

const empty: CohortInput = {
  name: "",
  cohort_number: null,
  starts_on: "",
  ends_on: "",
  capacity: 24,
  status: "upcoming",
  price_cents: 13000,
  applications_close_at: null,
};

export function CohortsManager({ initialCohorts }: { initialCohorts: Cohort[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<CohortInput | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function save(input: CohortInput) {
    setError(undefined);
    start(async () => {
      try {
        // Strip extras the DB row carries (enrollments aggregate,
        // stripe_*_id, created_at) so the server action only sees the
        // editable fields.
        const clean: CohortInput = {
          id: input.id,
          name: input.name,
          cohort_number: input.cohort_number ?? null,
          starts_on: input.starts_on ?? null,
          ends_on: input.ends_on ?? null,
          capacity: input.capacity,
          status: input.status,
          price_cents: input.price_cents,
          applications_close_at: input.applications_close_at ?? null,
        };
        const res = await saveCohort(clean);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setEditing(null);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function confirmDelete() {
    if (!confirmDeleteId) return;
    setError(undefined);
    start(async () => {
      try {
        const res = await deleteCohort(confirmDeleteId);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setConfirmDeleteId(null);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  const cohortToDelete =
    initialCohorts.find((c) => c.id === confirmDeleteId) ?? null;

  if (editing) {
    return (
      <CohortForm
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
        <Button onClick={() => setEditing(empty)}>
          <Plus className="h-4 w-4" /> New cohort
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-mono uppercase tracking-wider text-ink-faint">
            <th className="pb-3">#</th>
            <th className="pb-3">Name</th>
            <th className="pb-3">Dates</th>
            <th className="pb-3">Capacity</th>
            <th className="pb-3">Enrolled</th>
            <th className="pb-3">Price</th>
            <th className="pb-3">Status</th>
            <th className="pb-3"></th>
          </tr>
        </thead>
        <tbody>
          {initialCohorts.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0 hover:bg-wash">
              <td className="py-3 text-ink-soft tabular-nums">
                {c.cohort_number != null ? `#${c.cohort_number}` : "—"}
              </td>
              <td className="py-3 text-ink">{c.name}</td>
              <td className="py-3 text-ink-soft tabular-nums">
                {c.starts_on || "—"} → {c.ends_on || "—"}
              </td>
              <td className="py-3 text-ink-soft tabular-nums">{c.capacity}</td>
              <td className="py-3 text-ink-soft tabular-nums">
                {c.enrollments?.[0]?.count ?? 0}
              </td>
              <td className="py-3 text-ink-soft tabular-nums">
                ${(c.price_cents / 100).toFixed(0)}
              </td>
              <td className="py-3"><StatusBadge status={c.status} /></td>
              <td className="py-3 text-right">
                <Link
                  href={`/admin/cohorts/${c.id}/health`}
                  className="inline-block p-1.5 text-ink-faint hover:text-phosphor-ink"
                  aria-label="View health"
                  title="Cohort health"
                >
                  <Activity className="h-4 w-4" />
                </Link>
                <button
                  onClick={() => setEditing(c)}
                  className="p-1.5 text-ink-faint hover:text-ink"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(c.id!)}
                  className="p-1.5 text-ink-faint hover:text-red-700 dark:hover:text-red-300"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {initialCohorts.length === 0 && (
            <tr>
              <td colSpan={8} className="py-6 text-center text-sm text-ink-faint">
                No cohorts. Create your first.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {error && <p className="mt-4 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete cohort?"
        description={
          cohortToDelete ? (
            <>
              <p>
                <span className="text-ink">{cohortToDelete.name}</span> and any
                enrollments referencing it will be removed.
              </p>
              <p className="mt-2 text-amber-700 dark:text-amber-300">
                This cannot be undone.
              </p>
            </>
          ) : null
        }
        confirmLabel="Delete cohort"
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => !pending && setConfirmDeleteId(null)}
      />
    </div>
  );
}

function CohortForm({
  initial,
  onCancel,
  onSave,
  pending,
  error,
}: {
  initial: CohortInput;
  onCancel: () => void;
  onSave: (c: CohortInput) => void;
  pending: boolean;
  error?: string;
}) {
  const [c, setC] = useState<CohortInput>(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(c);
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            required
            placeholder="Fall 2026"
            value={c.name}
            onChange={(e) => setC({ ...c, name: e.target.value })}
          />
          <p className="mt-1 text-xs text-ink-faint">
            Season label shown across the site (e.g. "Fall 2026") — match
            the actual dates, or the whole site mislabels the cohort.
          </p>
        </div>
        <div>
          <Label htmlFor="cohort_number">Cohort #</Label>
          <Input
            id="cohort_number"
            type="number"
            min={1}
            placeholder="1"
            value={c.cohort_number ?? ""}
            onChange={(e) =>
              setC({
                ...c,
                cohort_number:
                  e.target.value === "" ? null : parseInt(e.target.value) || null,
              })
            }
          />
          <p className="mt-1 text-xs text-ink-faint">
            Renders as "Cohort N".
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="starts_on">Starts on</Label>
          <Input
            id="starts_on"
            type="date"
            value={c.starts_on ?? ""}
            onChange={(e) => setC({ ...c, starts_on: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="ends_on">Ends on</Label>
          <Input
            id="ends_on"
            type="date"
            value={c.ends_on ?? ""}
            onChange={(e) => setC({ ...c, ends_on: e.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="capacity">Capacity</Label>
          <Input
            id="capacity"
            type="number"
            min={1}
            value={c.capacity}
            onChange={(e) =>
              setC({ ...c, capacity: parseInt(e.target.value) || 0 })
            }
          />
        </div>
        <div>
          <Label htmlFor="price_cents">Price (USD cents)</Label>
          <Input
            id="price_cents"
            type="number"
            min={0}
            value={c.price_cents}
            onChange={(e) =>
              setC({ ...c, price_cents: parseInt(e.target.value) || 0 })
            }
          />
        </div>
        <div>
          <Label htmlFor="status">Status</Label>
          <Select
            id="status"
            value={c.status}
            onChange={(e) => setC({ ...c, status: e.target.value as any })}
          >
            <option value="upcoming">Upcoming</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="apps_close_at">Applications close</Label>
        <Input
          id="apps_close_at"
          type="datetime-local"
          // datetime-local needs the value without timezone suffix.
          value={
            c.applications_close_at
              ? c.applications_close_at.slice(0, 16)
              : ""
          }
          onChange={(e) =>
            setC({
              ...c,
              applications_close_at: e.target.value
                ? // Treat the input as UTC so the stored timestamp
                  // matches what the admin entered without timezone
                  // surprises across deploys.
                  new Date(`${e.target.value}:00Z`).toISOString()
                : null,
            })
          }
        />
        <p className="mt-1 text-xs text-ink-faint">
          Optional. When set, the landing page shows a countdown
          ("Applications close in N days").
        </p>
      </div>
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save cohort"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
