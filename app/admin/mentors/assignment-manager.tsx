"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, Label } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { assignMentor, unassignMentor } from "./actions";
import { Plus, Trash2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Profile = { id: string; email: string; full_name: string | null };
type Cohort = { id: string; name: string };
type Assignment = {
  id: string;
  mentor_id: string;
  student_id: string;
  cohort_id: string | null;
  mentor: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null;
  student: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null;
  cohort: { name: string } | { name: string }[] | null;
};

function pick<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function AssignmentManager({
  mentors,
  students,
  cohorts,
  assignments,
}: {
  mentors: Profile[];
  students: any[];
  cohorts: Cohort[];
  assignments: Assignment[];
}) {
  const router = useRouter();
  const [mentorId, setMentorId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [cohortId, setCohortId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function add() {
    if (!mentorId || !studentId) {
      setError("Pick both a mentor and a student.");
      return;
    }
    setError(undefined);
    start(async () => {
      try {
        await assignMentor({
          mentorId,
          studentId,
          cohortId: cohortId || null,
        });
        setMentorId("");
        setStudentId("");
        setCohortId("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function executeDelete() {
    if (!confirmDeleteId) return;
    setError(undefined);
    const id = confirmDeleteId;
    start(async () => {
      try {
        await unassignMentor(id);
        setConfirmDeleteId(null);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  const itemToDelete = assignments.find((a) => a.id === confirmDeleteId);

  return (
    <div>
      {mentors.length === 0 ? (
        <p className="rounded-lg border border-amber-300/30 bg-amber-300/5 p-3 text-sm text-amber-200">
          You don't have any users with the mentor role yet. Promote someone
          to mentor in the People page first.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-1">
            <Label>Mentor</Label>
            <Select value={mentorId} onChange={(e) => setMentorId(e.target.value)}>
              <option value="">— Pick mentor —</option>
              {mentors.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.email}
                </option>
              ))}
            </Select>
          </div>
          <div className="md:col-span-1">
            <Label>Student</Label>
            <Select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">— Pick student —</option>
              {students.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.full_name || s.email}
                </option>
              ))}
            </Select>
          </div>
          <div className="md:col-span-1">
            <Label>Cohort (optional)</Label>
            <Select value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
              <option value="">— Any —</option>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end md:col-span-1">
            <Button onClick={add} disabled={pending} className="w-full">
              <Plus className="h-4 w-4" />
              Assign
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <table className="mt-8 w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
            <th className="px-3 py-3">Mentor</th>
            <th className="px-3 py-3">Student</th>
            <th className="px-3 py-3">Cohort</th>
            <th className="px-3 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {assignments.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-sm text-white/50">
                No assignments yet.
              </td>
            </tr>
          )}
          {assignments.map((a) => {
            const m = pick(a.mentor);
            const s = pick(a.student);
            const c = pick(a.cohort);
            return (
              <tr key={a.id} className="border-b border-white/5 last:border-0">
                <td className="px-3 py-3 text-white">
                  {m?.full_name || m?.email}
                </td>
                <td className="px-3 py-3 text-white">
                  {s?.full_name || s?.email}
                </td>
                <td className="px-3 py-3 text-white/60">
                  {c?.name ?? <span className="text-white/30">—</span>}
                </td>
                <td className="px-3 py-3 text-right">
                  <button
                    onClick={() => setConfirmDeleteId(a.id)}
                    className="p-1.5 text-white/50 hover:text-red-400"
                    aria-label="Unassign"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Unassign mentor?"
        description={
          itemToDelete && (
            <p>
              The mentor will lose visibility into this student. You can
              re-assign at any time.
            </p>
          )
        }
        confirmLabel="Unassign"
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDeleteId(null)}
      />
    </div>
  );
}
