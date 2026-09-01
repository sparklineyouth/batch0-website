"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { grantRoleByEmail } from "./actions";

/**
 * Assign a role to someone who already has an account.
 *
 * This is the whole "sign up, don't apply" path: a person creates an account
 * at /signup like anyone else, and an admin types their email here. No
 * application, no cohort, no payment.
 */
export function GrantRoleForm({
  roles,
}: {
  roles: { slug: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [slug, setSlug] = useState(roles[0]?.slug ?? "");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

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
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            required
          />
        </div>
        <div className="sm:w-44">
          <Label htmlFor="grant-role">Role</Label>
          <Select
            id="grant-role"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending || !email}>
          {pending ? "Assigning…" : "Assign"}
        </Button>
      </div>
      {message && (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
      )}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </form>
  );
}
