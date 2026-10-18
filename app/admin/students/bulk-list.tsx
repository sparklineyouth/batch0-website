"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CheckSquare, Lock, Square } from "lucide-react";
import { RoleSelect, type RoleOption } from "./role-select";
import { bulkChangeUserRole } from "./actions";
import { getActionError } from "@/lib/action-error";
import { roleColorClasses } from "@/lib/permissions";
import { ADMIN_PAGES } from "@/lib/nav-config";
import { FIXTURE_NOT_SENT, previewRoleAssignment, type ImpactRole } from "@/lib/role-impact";
import type { RoleChangeActor } from "@/lib/role-change";
import { AccessImpact } from "@/components/admin/role-impact";
import type { Role } from "@/lib/types";

type Row = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  /** The viewer may not change this person's role (see lib/role-change.ts). */
  role_locked: boolean;
  /** Why, in the guard's words, when the viewer may change roles at all. */
  role_lock_reason: string | null;
  created_at: string;
  latest_app_status: string | null;
  cohort_name: string | null;
};

export function StudentsBulkList({
  rows,
  roleOptions,
  roleBadges,
  canChangeRoles,
  actor,
  impactRoles,
  fixture = false,
}: {
  rows: Row[];
  /** Assignable roles, from public.app_roles. */
  roleOptions: RoleOption[];
  /** Every role, for badge labels and colours. */
  roleBadges: RoleOption[];
  /** False when the viewer can read the directory but not re-role anyone. */
  canChangeRoles: boolean;
  /** The viewer, for the bulk change's preview of what the guard will do. */
  actor: RoleChangeActor | null;
  /** Every role with what it holds, for the previews (empty without people.roles). */
  impactRoles: ImpactRole[];
  /** /dev/roles: Apply and the row pickers never call the server (FIXTURE_NOT_SENT). */
  fixture?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [confirmRole, setConfirmRole] = useState<Role | null>(null);
  const [bulkRole, setBulkRole] = useState<Role>(
    roleOptions[0]?.slug ?? "student",
  );
  const [err, setErr] = useState<string | undefined>();
  const [lastResult, setLastResult] = useState<string | undefined>();

  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);

  // The guard's answer for the selection, before Apply (lib/role-impact.ts).
  // Only rows on this page can be previewed; a selection carried over from
  // another page is still sent, and the server decides those too.
  const preview = useMemo(() => {
    if (!confirmRole || !actor) return null;
    const targets = rows
      .filter((r) => selected.has(r.id))
      .map((r) => ({ id: r.id, role: r.role as string }));
    return {
      unseen: selected.size - targets.length,
      ...previewRoleAssignment({ actor, roles: impactRoles, targets, nextRole: confirmRole, pages: ADMIN_PAGES }),
    };
  }, [confirmRole, actor, rows, selected, impactRoles]);
  const names = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.id, r.full_name || r.email || "Someone"])),
    [rows],
  );
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
    if (fixture) {
      setConfirmRole(null);
      setLastResult(FIXTURE_NOT_SENT);
      return;
    }
    start(async () => {
      try {
        const res = await bulkChangeUserRole({
          userIds: Array.from(selected),
          role,
        });
        if (res.error) {
          // Nothing changed (the role is one the viewer can't hand out);
          // keep the selection so they can pick another.
          setConfirmRole(null);
          setErr(res.error);
          return;
        }
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
              checked ? "bg-phosphor/5" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => toggle(p.id)}
              aria-label={checked ? "Deselect" : "Select"}
              className="-ml-1 -my-1 rounded p-1 text-ink-faint hover:text-ink"
            >
              {checked ? (
                <CheckSquare className="h-4 w-4 text-phosphor-ink" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
            <div className="truncate text-ink">{p.full_name || "—"}</div>
            <div className="truncate text-ink-soft">
              {p.email || <span className="text-ink-faint">—</span>}
            </div>
            <div>
              {canChangeRoles && !p.role_locked ? (
                <RoleSelect
                  userId={p.id}
                  role={p.role}
                  options={roleOptions}
                  roles={impactRoles}
                  name={p.full_name || p.email}
                  fixture={fixture}
                />
              ) : (
                <RoleBadge role={p.role} options={roleBadges} lockedBecause={p.role_lock_reason} />
              )}
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
                className="text-xs text-phosphor-ink hover:underline"
              >
                Manage →
              </Link>
            </div>
          </div>
        );
      })}

      {someSelected && canChangeRoles && (
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
              {roleOptions.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.label}
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
        title={`Change ${selected.size} user${selected.size === 1 ? "" : "s"} to ${
          roleOptions.find((r) => r.slug === confirmRole)?.label ?? confirmRole
        }?`}
        confirmLabel="Update roles"
        pending={pending}
        // Nothing would change: the description says why.
        confirmDisabled={
          !!preview && (preview.error !== null || (preview.moves.length === 0 && preview.unseen === 0))
        }
        onCancel={() => !pending && setConfirmRole(null)}
        onConfirm={() => confirmRole && runBulk(confirmRole)}
        description={
          preview ? (
            <BulkPreview preview={preview} names={names} />
          ) : (
            <p className="text-sm text-ink-soft">
              Their access changes right away. Your own account, anyone whose
              role holds access you don&apos;t have, and anyone already in this
              role are skipped.
            </p>
          )
        }
      />
    </div>
  );
}

/**
 * What the bulk change will do, before Apply: who moves from which role and
 * what that does to them, and who the guard skips, and why. Exported for the
 * fixture preview at /dev/roles.
 */
export function BulkPreview({
  preview,
  names,
}: {
  preview: ReturnType<typeof previewRoleAssignment> & { unseen: number };
  /** Display names by id, for the few people a reason skips. */
  names: Record<string, string>;
}) {
  if (preview.error !== null) {
    return <p className="text-sm text-red-700 dark:text-red-300">{preview.error}</p>;
  }
  const next = preview.next?.label ?? "";
  return (
    <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
      {preview.moves.length === 0 && preview.unseen === 0 && (
        <p className="text-sm text-ink-soft">Nobody selected would change.</p>
      )}
      {preview.moves.map((m) => (
        <div key={m.from}>
          <p className="mb-1.5 text-xs font-medium text-ink">
            {m.ids.length} {m.fromLabel} → {next}
          </p>
          <AccessImpact diff={m.diff} showPermissions />
        </div>
      ))}
      {preview.unseen > 0 && (
        <p className="text-xs text-ink-faint">
          {preview.unseen} more selected on another page are checked when you apply.
        </p>
      )}
      {preview.skipped.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink">Skipped</p>
          <ul className="space-y-1.5 text-xs leading-snug text-ink-soft">
            {preview.skipped.map((s) => (
              <li key={s.reason}>
                <span className="tabular-nums">{s.ids.length}</span> · {s.reason}
                {s.ids.length <= 3 && (
                  <span className="text-ink-faint"> ({s.ids.map((id) => names[id] ?? "Someone").join(", ")})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(preview.moves.length > 0 || preview.unseen > 0) && (
        <p className="text-xs text-ink-faint">Their access changes right away.</p>
      )}
    </div>
  );
}

/**
 * Static role badge: for viewers who can read the directory but not edit it,
 * and on rows the viewer may not re-role, with the guard's reason.
 */
function RoleBadge({
  role,
  options,
  lockedBecause = null,
}: {
  role: Role;
  options: RoleOption[];
  lockedBecause?: string | null;
}) {
  const match = options.find((o) => o.slug === role);
  return (
    <span
      title={lockedBecause ?? undefined}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${roleColorClasses(
        match?.color ?? "slate",
      )}`}
    >
      {match?.label ?? role}
      {lockedBecause && (
        <>
          <Lock aria-hidden className="h-3 w-3 opacity-60" />
          <span className="sr-only">: {lockedBecause}</span>
        </>
      )}
    </span>
  );
}
