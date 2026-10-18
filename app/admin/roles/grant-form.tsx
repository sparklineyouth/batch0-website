"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { AccessImpact } from "@/components/admin/role-impact";
import { ADMIN_PAGES } from "@/lib/nav-config";
import { diffRoleAccess, type ImpactRole } from "@/lib/role-impact";
import { grantRoleByEmail, previewRoleGrant } from "./actions";

type Preview =
  | { state: "idle" }
  | { state: "loading"; key: string }
  | { state: "error"; key: string; message: string }
  | {
      state: "ready";
      key: string;
      name: string;
      email: string;
      role: string;
      refusal: string | null;
    };

/** Looks enough like an address to be worth looking up. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Assign a role to someone who already has an account.
 *
 * This is the whole "sign up, don't apply" path: a person creates an account
 * at /signup like anyone else, and an admin types their email here. No
 * application, no cohort, no payment.
 *
 * Once the email looks complete, the form asks the server who it belongs to
 * and whether the guard would allow this change (previewRoleGrant: reads
 * only), then shows what that person would gain or lose next to the role they
 * hold now, so a refusal is explained before Assign rather than after. The
 * write checks everything again.
 */
export function GrantRoleForm({
  roles,
  allRoles,
  hiddenRoles,
}: {
  /** The roles the viewer may hand out. */
  roles: ImpactRole[];
  /** Every role, to read what the person holds now. */
  allRoles: ImpactRole[];
  /** How many roles aren't offered because they hold permissions the viewer doesn't. */
  hiddenRoles: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [slug, setSlug] = useState(roles[0]?.slug ?? "");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const latest = useRef("");

  const clean = email.trim().toLowerCase();
  const key = `${clean}\u0000${slug}`;

  // Debounced, and only the answer for what's in the form now is kept: a
  // slow reply for "ada@example.co" can't overwrite the one for ".com".
  useEffect(() => {
    latest.current = key;
    if (!LOOKS_LIKE_EMAIL.test(clean) || !slug) {
      setPreview({ state: "idle" });
      return;
    }
    const timer = setTimeout(() => {
      setPreview({ state: "loading", key });
      previewRoleGrant(clean, slug)
        .then((res) => {
          if (latest.current !== key) return;
          setPreview(
            res.ok
              ? { state: "ready", key, ...res.data! }
              : { state: "error", key, message: res.error },
          );
        })
        .catch(() => {
          // A preview that can't load is no reason to block Assign.
          if (latest.current === key) setPreview({ state: "idle" });
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [clean, slug, key]);

  const current = preview.state === "ready" && preview.key === key ? preview : null;
  const from = current ? allRoles.find((r) => r.slug === current.role) : undefined;
  const next = roles.find((r) => r.slug === slug);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setMessage(undefined);
    start(async () => {
      const res = await grantRoleByEmail(email, slug);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const label = roles.find((r) => r.slug === slug)?.label ?? slug;
      setMessage(`${res.data!.name} is now ${label}.`);
      setEmail("");
      setPreview({ state: "idle" });
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <Label htmlFor="grant-email">Email of an existing account</Label>
          <Input
            id="grant-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setMessage(undefined);
              setError(undefined);
            }}
            placeholder="person@example.com"
            required
          />
        </div>
        <div className="sm:w-44">
          <Label htmlFor="grant-role">Role</Label>
          <Select
            id="grant-role"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setError(undefined);
            }}
          >
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending || !email || !!current?.refusal}>
          {pending ? "Assigning…" : "Assign"}
        </Button>
      </div>
      {hiddenRoles > 0 && (
        <p className="text-xs text-ink-faint">
          {hiddenRoles === 1 ? "One role isn't" : `${hiddenRoles} roles aren't`} listed: you can only
          assign a role that holds nothing you don&apos;t.
        </p>
      )}

      {preview.state === "loading" && preview.key === key && (
        <p className="text-xs text-ink-faint">Looking up {clean}…</p>
      )}
      {preview.state === "error" && preview.key === key && (
        <p className="text-xs text-ink-faint">{preview.message}</p>
      )}
      {current && next && (
        <GrantPreview
          name={current.name}
          email={current.email}
          currentRole={from ?? { slug: current.role, label: current.role, permissions: [] }}
          next={next}
          refusal={current.refusal}
        />
      )}

      {message && (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
      )}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </form>
  );
}

/**
 * The account an email belongs to and what the role would do to them, or the
 * guard's reason it wouldn't be allowed. Exported for the fixture preview at
 * /dev/roles.
 */
export function GrantPreview({
  name,
  email,
  currentRole,
  next,
  refusal,
}: {
  name: string;
  email: string;
  /** The role they hold now (one that no longer exists holds nothing). */
  currentRole: ImpactRole;
  next: ImpactRole;
  refusal: string | null;
}) {
  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <p className="text-xs text-ink-soft">
        <span className="font-medium text-ink">{name}</span>
        {name !== email && <span className="text-ink-faint"> · {email}</span>} holds{" "}
        {currentRole.label} now.
        {!refusal && <> As {next.label}, they would:</>}
      </p>
      {refusal ? (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300">{refusal}</p>
      ) : (
        <div className="mt-2">
          <AccessImpact
            showPermissions
            diff={diffRoleAccess(currentRole.permissions, next.permissions, {
              pages: ADMIN_PAGES,
              home: { before: currentRole.home_path ?? null, after: next.home_path ?? null },
            })}
          />
        </div>
      )}
    </div>
  );
}
