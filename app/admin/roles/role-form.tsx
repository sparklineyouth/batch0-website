"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Label, Select, Textarea, FieldError } from "@/components/ui/input";
import {
  PERMISSION_GROUPS,
  ROLE_COLOR_KEYS,
  ROLE_HOME_OPTIONS,
  roleColorClasses,
  slugifyRole,
} from "@/lib/permissions";
import { createRole, updateRole, type RoleInput } from "./actions";

export type RoleFormValues = {
  slug: string;
  label: string;
  description: string;
  permissions: string[];
  homePath: string;
  color: string;
};

/**
 * Create/edit form for a role. The checkbox grid is generated from
 * PERMISSION_GROUPS, so a permission added to the catalog shows up here
 * without touching this file.
 */
export function RoleForm({
  mode,
  initial,
  /** Permissions the signed-in admin can hand out. null = everything. */
  grantable,
}: {
  mode: "create" | "edit";
  initial: RoleFormValues;
  grantable: string[] | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const [label, setLabel] = useState(initial.label);
  const [slug, setSlug] = useState(initial.slug);
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [description, setDescription] = useState(initial.description);
  const [homePath, setHomePath] = useState(initial.homePath);
  const [color, setColor] = useState(initial.color);
  const [permissions, setPermissions] = useState<Set<string>>(
    () => new Set(initial.permissions),
  );

  // A permission the role already carries stays togglable even when the
  // editor doesn't hold it — keeping it is not an escalation, and removing it
  // never is. Only *adding* one you lack is blocked (mirrors assertCanGrant).
  const alreadyHeld = useMemo(
    () => new Set(initial.permissions),
    [initial.permissions],
  );
  const canGrant = useMemo(
    () => (key: string) =>
      grantable === null || grantable.includes(key) || alreadyHeld.has(key),
    [grantable, alreadyHeld],
  );

  const effectiveSlug = slugTouched ? slug : slugifyRole(label);
  const count = permissions.size;

  function toggle(key: string) {
    setSaved(false);
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(keys: string[], on: boolean) {
    setSaved(false);
    setPermissions((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (!canGrant(k)) continue;
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    const payload: RoleInput = {
      slug: mode === "edit" ? initial.slug : effectiveSlug,
      label,
      description,
      permissions: Array.from(permissions),
      homePath,
      color,
    };
    start(async () => {
      const res =
        mode === "create" ? await createRole(payload) : await updateRole(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (mode === "create") {
        router.push(`/admin/roles/${(res.data as { slug: string }).slug}`);
        router.refresh();
      } else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <Label htmlFor="role-label" required>
            Name *
          </Label>
          <Input
            id="role-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Intern"
            maxLength={40}
            required
          />
          <p className="mt-1 text-xs text-ink-faint">
            {mode === "edit" ? (
              <>
                Slug <code className="font-mono">{initial.slug}</code> — fixed
                once created.
              </>
            ) : (
              <>
                Slug will be{" "}
                <code className="font-mono text-ink-soft">
                  {effectiveSlug || "…"}
                </code>
              </>
            )}
          </p>
        </div>

        {mode === "create" && (
          <div>
            <Label htmlFor="role-slug">Slug</Label>
            <Input
              id="role-slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugifyRole(e.target.value));
              }}
              placeholder="intern"
              maxLength={32}
            />
            <p className="mt-1 text-xs text-ink-faint">
              Used in URLs and stored on each profile. Can&apos;t be changed later.
            </p>
          </div>
        )}

        <div className={mode === "create" ? "md:col-span-2" : ""}>
          <Label htmlFor="role-desc">What this role is for</Label>
          <Textarea
            id="role-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Helps run the programme day to day. No money, no role changes."
            maxLength={400}
            className="min-h-20"
          />
        </div>

        <div>
          <Label htmlFor="role-home">Lands on</Label>
          <Select
            id="role-home"
            value={homePath}
            onChange={(e) => setHomePath(e.target.value)}
          >
            {ROLE_HOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-ink-faint">
            Where they go after signing in. Falls back automatically if the role
            can&apos;t reach it.
          </p>
        </div>

        <div>
          <Label>Badge colour</Label>
          <div className="flex flex-wrap gap-2 pt-1">
            {ROLE_COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-pressed={color === c}
                className={`rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wider transition ${roleColorClasses(
                  c,
                )} ${
                  color === c
                    ? "ring-2 ring-phosphor/50 ring-offset-1 ring-offset-wash"
                    : "opacity-60 hover:opacity-100"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
            What they can do
          </h2>
          <p className="text-xs text-ink-faint tabular-nums">
            {count} permission{count === 1 ? "" : "s"} selected
          </p>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Each tick adds the matching section to their sidebar and authorises the
          actions on it. Untick and the page disappears — and stays blocked even
          if they type the URL.
        </p>

        <div className="mt-5 space-y-6">
          {PERMISSION_GROUPS.map((group) => {
            const keys = group.permissions.map((p) => p.key);
            const grantableKeys = keys.filter(canGrant);
            const allOn =
              grantableKeys.length > 0 &&
              grantableKeys.every((k) => permissions.has(k));
            return (
              <fieldset key={group.label}>
                <legend className="sr-only">{group.label}</legend>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-ink-faint">
                    {group.label}
                  </p>
                  {grantableKeys.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(grantableKeys, !allOn)}
                      className="text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                    >
                      {allOn ? "Clear all" : "Select all"}
                    </button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.permissions.map((p) => {
                    const allowed = canGrant(p.key);
                    const on = permissions.has(p.key);
                    return (
                      <label
                        key={p.key}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                          on
                            ? "border-phosphor/40 bg-phosphor/[0.06]"
                            : "border-line bg-paper hover:border-ink/25"
                        } ${allowed ? "" : "cursor-not-allowed opacity-45"}`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!allowed}
                          onChange={() => toggle(p.key)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-phosphor"
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                            {p.label}
                            {p.sensitive && (
                              <span className="rounded-full border border-amber-500/40 px-1.5 py-px text-[9px] font-mono uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                sensitive
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                            {allowed
                              ? p.description
                              : "You don't hold this permission yourself, so you can't grant it."}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Create role"
              : "Save changes"}
        </Button>
        {/* An anchor, so it can no longer be hijacked into submitting the
            surrounding <form> — the old type="button" was the only thing
            standing between this "Cancel" and a save. */}
        <ButtonLink href="/admin/roles" variant="secondary">
          {mode === "create" ? "Cancel" : "Back to roles"}
        </ButtonLink>
        {saved && (
          <span className="text-sm text-emerald-700 dark:text-emerald-300">
            Saved. Anyone holding this role sees the change on their next page load.
          </span>
        )}
      </div>
    </form>
  );
}
