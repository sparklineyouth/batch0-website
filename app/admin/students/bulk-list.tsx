"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CheckSquare, Square } from "lucide-react";
import { RoleSelect } from "./role-select";
import { bulkChangeUserRole } from "./actions";
import { getActionError } from "@/lib/action-error";
import type { Role } from "@/lib/types";

type Row = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  created_at: string;
  latest_app_status: string | null;
  cohort_name: string | null;
};

const ROLE_OPTIONS: Role[] = ["student", "mentor", "investor", "admin"];

export function StudentsBulkList({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [confirmRole, setConfirmRole] = useState<Role | null>(null);
  const [bulkRole, setBulkRole] = useState<Role>("student");
  const [err, setErr] = useState<string | undefined>();
  const [lastResult, setLastResult] = useState<string | undefined>();

  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allIds));
  }

  function runBulk(role: Role) {
    setErr(undefined);
    setLastResult(undefined);
    start(async () => {
      try {
        const res = await bulkChangeUserRole({
          userIds: Array.from(selected),
          role,
        });
        const parts = [`${res.succeeded} updated`];
        if (res.failed > 0) parts.push(`${res.failed} failed`);
        if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
        setLastResult(parts.join(" · "));
        setConfirmRole(null);
        setSelected(new Set());
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-ink-faint">No matching people.</p>;
  }

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.6fr)] items-center gap-3 border-b border-line bg-wash px-5 py-3 text-xs font-mono uppercase tracking-wider text-ink-faint">
        <button
          type="button"
          onClick={toggleAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
          className="-ml-1 -my-1 rounded p-1 text-ink-faint hover:text-ink"
        >
          {allSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
        <div>Name</div>
        <div>Email</div>
        <div>Role</div>
        <div>Application</div>
        <div>Cohort</div>
        <div>Joined</div>
        <div />
      </div>

      {rows.map((p) => {
        const checked = selected.has(p.id);
        return (
          <div
            key={p.id}
            className={`grid grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.6fr)] items-center gap-3 border-b border-line px-5 py-3 last:border-0 hover:bg-wash ${
              checked ? "bg-spark/5" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => toggle(p.id)}
              aria-label={checked ? "Deselect" : "Select"}
              className="-ml-1 -my-1 rounded p-1 text-ink-faint hover:text-ink"
            >
              {checked ? (
                <CheckSquare className="h-4 w-4 text-spark-ink" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
            <div className="truncate text-ink">{p.full_name || "—"}</div>
            <div className="truncate text-ink-soft">{p.email}</div>
            <div>
              <RoleSelect userId={p.id} role={p.role} />
            </div>
            <div>
              {p.latest_app_status ? (
                <StatusBadge status={p.latest_app_status} />
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </div>
            <div className="truncate text-ink-soft">
              {p.cohort_name ?? <span className="text-ink-faint">—</span>}
            </div>
            <div className="text-ink-faint font-mono tabular-nums">
              <LocalTime value={p.created_at} mode="date" />
            </div>
            <div className="text-right">
              <Link
                href={`/admin/students/${p.id}`}
                className="text-xs text-spark-ink hover:underline"
              >
                Manage →
              </Link>
            </div>
          </div>
        );
      })}

      {someSelected && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-wash/95 backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
            <div className="text-sm">
              <span className="font-semibold text-ink tabular-nums">{selected.size}</span>
              <span className="text-ink-soft"> selected</span>
            </div>
            {lastResult && (
              <span className="text-xs text-emerald-700 dark:text-emerald-300">{lastResult}</span>
            )}
            {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pending}
            >
              Clear
            </Button>
            <label className="text-xs text-ink-soft">Change role to</label>
            <Select
              value={bulkRole}
              onChange={(e) => setBulkRole(e.target.value as Role)}
              className="!h-8 w-32"
              disabled={pending}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              onClick={() => setConfirmRole(bulkRole)}
              disabled={pending}
            >
              Apply
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRole !== null}
        title={`Change ${selected.size} user${selected.size === 1 ? "" : "s"} to ${confirmRole}?`}
        confirmLabel="Update roles"
        pending={pending}
        onCancel={() => !pending && setConfirmRole(null)}
        onConfirm={() => confirmRole && runBulk(confirmRole)}
        description={
          <p className="text-sm text-ink-soft">
            Each user's role is updated and any linked Discord membership
            is re-synced. You can't downgrade your own admin role through
            this flow — it's skipped automatically.
          </p>
        }
      />
    </div>
  );
}
