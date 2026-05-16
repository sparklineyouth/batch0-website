"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";

const REF_KEY = "sparkline_ref";

export function SignupForm() {
  const [fullName, setFullName] = useState("");

  // Capture ?ref= from URL on mount and stash for later (sticks across
  // the email-confirmation hop).
  useEffect(() => {
    const ref = new URL(window.location.href).searchParams.get("ref");
    if (ref) {
      try {
        window.localStorage.setItem(REF_KEY, ref.slice(0, 32));
      } catch {}
    }
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resendState, setResendState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [resendMessage, setResendMessage] = useState<string | undefined>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }
    // If email confirmation is required, session is null until verified.
    if (!data.session) {
      setNeedsVerify(true);
      setLoading(false);
      return;
    }
    window.location.assign("/dashboard");
  }

  async function resendVerification() {
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
    setResendMessage("New verification link sent.");
  }

  if (needsVerify) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 rounded-lg border border-spark/30 bg-spark/5 p-4 text-sm text-white/85"
      >
        <p className="font-medium text-spark">Check your email</p>
        <p className="mt-1 text-white/70">
          We sent a verification link to{" "}
          <span className="text-white">{email}</span>. Click it to activate
          your account, then log in.
        </p>
        <p className="mt-3 text-xs text-white/60">
          Didn't get it? Check spam, or resend below.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={resendVerification}
            disabled={resendState === "sending" || resendState === "sent"}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/85 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resendState === "sending"
              ? "Sending…"
              : resendState === "sent"
                ? "Sent"
                : "Resend verification email"}
          </button>
          {resendMessage && (
            <span
              className={`text-xs ${
                resendState === "error" ? "text-red-300" : "text-white/65"
              }`}
            >
              {resendMessage}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <Label htmlFor="fullName" required>
          Full name
        </Label>
        <Input
          id="fullName"
          autoComplete="name"
          required
          aria-required="true"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
      </div>
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
          autoComplete="new-password"
          minLength={8}
          required
          aria-required="true"
          aria-describedby="password-hint signup-error"
          error={error ? true : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p id="password-hint" className="mt-1 text-xs text-white/55">
          At least 8 characters. Use letters and numbers — avoid common words.
        </p>
      </div>
      <FieldError id="signup-error">{error}</FieldError>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-xs text-white/55">
        By creating an account you agree to our{" "}
        <a href="/terms" className="underline-offset-2 hover:text-white hover:underline">
          Terms
        </a>{" "}
        and{" "}
        <a href="/privacy" className="underline-offset-2 hover:text-white hover:underline">
          Privacy Policy
        </a>
        .
      </p>
    </form>
  );
}
