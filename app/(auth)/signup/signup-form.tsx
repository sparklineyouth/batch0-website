"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";
import { signUpAction } from "./actions";

const REF_KEY = "sparkline_ref";

export function SignupForm({ next }: { next?: string }) {
  const [fullName, setFullName] = useState("");

  // Capture ?ref= from URL on mount and stash it so the apply flow can
  // pick it up later.
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);

    // Email verification is disabled for now. Create the account
    // server-side with the email pre-confirmed, then sign the user
    // straight in — no "check your inbox" round-trip.
    const result = await signUpAction({ email, password, fullName });
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      setError(friendlyAuthError(signInError));
      setLoading(false);
      return;
    }

    // Hard reload so the freshly-set auth cookies ride along on the next
    // request (client-side navigation can race cookie propagation and
    // bounce the user back to /login).
    const safeNext =
      next && next.startsWith("/") && !next.startsWith("//") ? next : null;
    window.location.assign(safeNext ?? "/dashboard");
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
