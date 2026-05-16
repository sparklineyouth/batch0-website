"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";

export function LoginForm({
  next,
  initialError,
}: {
  next?: string;
  initialError?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(initialError);
  const [loading, setLoading] = useState(false);
  // Surface a "Resend verification email" CTA when login fails because
  // the account exists but hasn't been confirmed yet — otherwise the
  // user is stuck with no obvious next step.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resendState, setResendState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [resendMessage, setResendMessage] = useState<string | undefined>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    setNeedsVerify(false);
    setResendState("idle");
    setResendMessage(undefined);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const code = (error.code || "").toLowerCase();
      const msg = (error.message || "").toLowerCase();
      if (code === "email_not_confirmed" || msg.includes("email not confirmed")) {
        setNeedsVerify(true);
      }
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }
    // Hard reload so the freshly-set Supabase auth cookies are sent on
    // the next request (router.push can race with cookie propagation
    // and bounce the user back to /login).
    //
    // Defense-in-depth: page.tsx already strips off-origin "next" values,
    // but if the gate is ever bypassed we still refuse anything that
    // isn't a same-origin path.
    const safe =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/dashboard";
    window.location.assign(safe);
  }

  async function resendVerification() {
    if (!email) return;
    setResendState("sending");
    setResendMessage(undefined);
    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${location.origin}/auth/callback`,
      },
    });
    if (error) {
      setResendState("error");
      setResendMessage(friendlyAuthError(error));
      return;
    }
    setResendState("sent");
    setResendMessage("New verification link sent. Check your inbox.");
  }

  return (
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="password" required>
          Password
        </Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          aria-required="true"
          error={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <FieldError id="login-error">{error}</FieldError>
      {needsVerify && (
        <div className="rounded-lg border border-spark/30 bg-spark/5 p-3 text-xs text-white/75">
          <div className="flex items-center justify-between gap-3">
            <span>Need a new verification link?</span>
            <button
              type="button"
              onClick={resendVerification}
              disabled={resendState === "sending" || resendState === "sent"}
              className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-medium text-white/85 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resendState === "sending"
                ? "Sending…"
                : resendState === "sent"
                  ? "Sent"
                  : "Resend email"}
            </button>
          </div>
          {resendMessage && (
            <p
              className={`mt-2 ${
                resendState === "error" ? "text-red-300" : "text-white/65"
              }`}
            >
              {resendMessage}
            </p>
          )}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
