"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { requestPasswordReset } from "./actions";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // An expired or reused reset link lands back here with ?error=… (see
  // app/auth/confirm/route.ts). Read from window.location rather than
  // useSearchParams so this page keeps prerendering — same reasoning as
  // login-form.tsx.
  useEffect(() => {
    const msg = new URLSearchParams(window.location.search).get("error");
    if (msg) setError(msg);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    // The email is minted and sent server-side (./actions.ts) — through
    // Resend, on our own domain, rather than Supabase's test mailer. Nothing
    // on this page needs supabase-js any more, so its ~63 kB gz chunk is
    // gone from the reset funnel entirely.
    const res = await requestPasswordReset(email);
    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }
    setSent(true);
    setLoading(false);
  }

  // The auth shell has no <main>, so this page's own (classless) root is the
  // skip-link target: <div> → <main>, same box, plus tabIndex={-1} so it's
  // focusable and screen readers actually move the cursor to it.
  return (
    <main id="main-content" tabIndex={-1}>
      <h1 className="text-2xl font-bold tracking-tight text-white">Reset password</h1>
      <p className="mt-1 text-sm text-white/65">
        Enter your email and we'll send you a reset link.
      </p>
      {sent ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-6 rounded-md border border-phosphor/30 bg-phosphor/5 p-4 text-sm text-white/85"
        >
          <p className="font-medium text-phosphor">Check your email</p>
          <p className="mt-1 text-white/70">
            If an account exists for{" "}
            <span className="text-white">{email}</span>, a reset link is on
            its way. The link expires in an hour.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="email" required>
              Email
            </Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-required="true"
              error={error ? true : undefined}
              aria-describedby={error ? "forgot-error" : undefined}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <FieldError id="forgot-error">{error}</FieldError>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-white/65">
        <Link href="/login" className="hover:text-white">
          Back to login
        </Link>
      </p>
    </main>
  );
}
