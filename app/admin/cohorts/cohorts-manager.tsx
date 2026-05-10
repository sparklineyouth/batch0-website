"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveCohort, deleteCohort, type CohortInput } from "./actions";
import { Pencil, Trash2, Plus } from "lucide-react";

type Cohort = CohortInput & {
  id: string;
  enrollments?: { count: number }[];
};

const empty: CohortInput = {
  name: "",
  starts_on: "",
  ends_on: "",
  capacity: 24,
  status: "upcoming",
  price_cents: 9700,
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
        await saveCohort(input);
        setEditing(null);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function confirmDelete() {
    if (!confirmDeleteId) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteCohort(confirmDeleteId);
        setConfirmDeleteId(null);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
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
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
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
            <tr key={c.id} className="border-b border-white/5 last:border-0">
              <td className="py-3 text-white">{c.name}</td>
              <td className="py-3 text-white/70">
                {c.starts_on || "—"} → {c.ends_on || "—"}
              </td>
              <td className="py-3 text-white/70">{c.capacity}</td>
              <td className="py-3 text-white/70">
                {c.enrollments?.[0]?.count ?? 0}
              </td>
              <td className="py-3 text-white/70">
                ${(c.price_cents / 100).toFixed(0)}
              </td>
              <td className="py-3"><StatusBadge status={c.status} /></td>
              <td className="py-3 text-right">
                <button
                  onClick={() => setEditing(c)}
                  className="p-1.5 text-white/50 hover:text-white"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDeleteId(c.id!)}
                  className="p-1.5 text-white/50 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {initialCohorts.length === 0 && (
            <tr>
              <td colSpan={7} className="py-6 text-center text-sm text-white/50">
                No cohorts. Create your first.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete cohort?"
        description={
          cohortToDelete ? (
            <>
              <p>
                <span className="text-white">{cohortToDelete.name}</span> and any
                enrollments referencing it will be removed.
              </p>
              <p className="mt-2 text-amber-300/80">
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
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          required
          value={c.name}
          onChange={(e) => setC({ ...c, name: e.target.value })}
        />
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
      {error && <p className="text-xs text-red-400">{error}</p>}
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
