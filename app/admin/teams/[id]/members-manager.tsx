"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { addTeamMember, removeTeamMember } from "../actions";
import { Plus, Trash2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Member = {
  id: string;
  role: string;
  user_id: string;
  user: { email: string; full_name: string | null } | { email: string; full_name: string | null }[] | null;
};
type Student = { id: string; email: string; full_name: string | null };

function pick<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function MembersManager({
  teamId,
  members,
  students,
}: {
  teamId: string;
  members: Member[];
  students: Student[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("founder");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const memberIds = new Set(members.map((m) => m.user_id));
  const candidates = students.filter((s) => !memberIds.has(s.id));

  function add() {
    if (!userId) return;
    setError(undefined);
    start(async () => {
      try {
        await addTeamMember({ teamId, userId, role });
        setUserId("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function remove(id: string) {
    setError(undefined);
    start(async () => {
      try {
        await removeTeamMember(id);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <Label>Add member</Label>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">— Pick someone —</option>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name || s.email}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Role</Label>
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="founder"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end">
        <Button size="sm" onClick={add} disabled={pending || !userId}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

      <ul className="mt-6 divide-y divide-line">
        {members.length === 0 && (
          <li className="py-4 text-sm text-ink-faint">No members yet.</li>
        )}
        {members.map((m) => {
          const u = pick(m.user);
          return (
            <li
              key={m.id}
              className="flex items-center justify-between py-2.5"
            >
              <div>
                <div className="text-sm text-ink">
                  {u?.full_name || "—"}
                </div>
                <div className="text-xs text-ink-faint">{u?.email}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-wash px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-soft">
                  {m.role}
                </span>
                <button
                  onClick={() => remove(m.id)}
                  className="text-ink-faint hover:text-red-700 dark:hover:text-red-300"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
