"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setConfirmError(undefined);
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setConfirmError("Passwords don't match.");
      return;
    }
    setLoading(true);
    // supabase-js is loaded at submit time (warmed on field focus below) so
    // its ~63 kB gz chunk stays out of this page's first-load JS. The client
    // is constructed here either way, so recovery-token detection (from the
    // reset link's URL) still happens at the same moment it always has.
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }
    window.location.assign("/dashboard");
  }

  // The auth shell has no <main>, so this page's own (classless) root is the
  // skip-link target: <div> → <main>, same box, plus tabIndex={-1} so it's
  // focusable and screen readers actually move the cursor to it.
  return (
    <main id="main-content" tabIndex={-1}>
      {/* Landing here without a session means the recovery link never got
          exchanged — expired, already used, or opened directly. Showing the
          form anyway is how this page used to send people in a circle: they'd
          type a new password and get a raw "Auth session missing!" back. The
          two branches are chosen in CSS from the `data-authed` flag on <html>
          (lib/auth-flag.ts), which is set before paint, so there's no flash of
          the wrong one and the page stays fully prerendered. */}
      <div className="when-anon">
        <h1 className="text-2xl font-bold tracking-tight text-white">
          This link has expired
        </h1>
        <p className="mt-1 text-sm text-white/65">
          Reset links work once and last an hour. Request a fresh one and
          we'll email it right over.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-on-phosphor"
        >
          Send a new link
        </Link>
        <p className="mt-6 text-center text-sm text-white/65">
          <Link href="/login" className="hover:text-white">
            Back to login
          </Link>
        </p>
      </div>

      <div className="when-authed">
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Set a new password
        </h1>
        <p className="mt-1 text-sm text-white/65">
          Choose something only you'll know. You'll stay signed in after this.
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="password" required>
              New password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              aria-required="true"
              aria-describedby="password-hint reset-error"
              error={error ? true : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => {
                // Warm the lazily-loaded supabase-js chunk (see onSubmit) so
                // the submit click doesn't stall on a network fetch.
                void import("@/lib/supabase/client").catch(() => {});
              }}
            />
            <p id="password-hint" className="mt-1 text-xs text-white/55">
              At least 8 characters.
            </p>
          </div>
          <div>
            <Label htmlFor="confirm" required>
              Confirm password
            </Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              aria-required="true"
              error={confirmError}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <FieldError id="confirm-error">{confirmError}</FieldError>
          </div>
          <FieldError id="reset-error">{error}</FieldError>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Saving…" : "Save password"}
          </Button>
        </form>
      </div>
    </main>
  );
}
