"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";
import { stashRefFromLocation } from "@/lib/referral-code";

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

  // A referred visitor who already has an account bounces to /login?next=…
  // with the code nested in `next`. Stash it so the apply flow still finds
  // it even if the URL query is dropped on the way back.
  useEffect(() => {
    stashRefFromLocation();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
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
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
