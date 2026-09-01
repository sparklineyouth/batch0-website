"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";
import { stashRefFromLocation } from "@/lib/referral-code";
import { signUpAction } from "./actions";

// Mirrors safeNext in app/(auth)/login/login-form.tsx — same-origin paths
// only, so a tampered ?next= can't trampoline the user off-site after signup.
function safeNext(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

/**
 * The whole signup card: heading copy, form, and login link. Everything that
 * depends on ?next (which copy variant, the post-signup redirect, the login
 * link's carried-along ?next) reads window.location in effects/handlers, not
 * useSearchParams — that hook would bail the entire card out of the
 * prerendered HTML and a slow-JS visitor would stare at an empty box. This
 * way the neutral heading, the full form, and the login link are all in the
 * static shell; the apply-flow copy variant and the ?next-carrying href swap
 * in one frame after mount for mid-apply visitors.
 */
export function SignupCard({ priceLabel }: { priceLabel: string }) {
  const [next, setNext] = useState<string | undefined>(undefined);
  useEffect(() => {
    setNext(safeNext(new URLSearchParams(window.location.search).get("next")));
  }, []);
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  // Only frame this as "step 1 of applying" when the visitor is actually
  // mid-apply. An account is a thing you can just have — staff, mentors, and
  // interns are given their role after signing up, never by applying — so a
  // bare /signup gets neutral copy.
  const isApplyFlow = !!next && (next === "/apply" || next.startsWith("/apply?"));

  return (
    <div>
      {isApplyFlow ? (
        <>
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-white/55">
            Apply · step 1 of 2
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">
            Create your account
          </h1>
          <p className="mt-2 text-sm leading-[1.6] text-white/50">
            The application itself is step 2 — one form about you and what
            you want to build. Applying is free;{" "}
            {priceLabel} tuition is charged only if you&apos;re
            accepted. Decisions go out by email on a rolling basis.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-white/50">
            Sign up for batch0. Takes 30 seconds. Applying to a cohort is a
            separate, optional step.
          </p>
        </>
      )}
      <SignupForm />
      <p className="mt-6 text-center text-sm text-white/50">
        Already have an account?{" "}
        <Link href={loginHref} className="text-phosphor hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}

export function SignupForm() {
  const [fullName, setFullName] = useState("");

  // Capture the referral code on mount and stash it so the apply flow can
  // pick it up later even if the URL query is lost. The middleware bounces
  // a logged-out /apply?ref=CODE visitor here as /signup?next=%2Fapply%3Fref%3DCODE,
  // so the code is usually nested inside `next` rather than a top-level ?ref.
  useEffect(() => {
    stashRefFromLocation();
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

    let supabase;
    try {
      // supabase-js is loaded at submit time (warmed on field focus below) so
      // its ~63 kB gz chunk stays out of the signup page's first-load JS. The
      // import can fail where the old static import couldn't (offline, deploy
      // skew) — and at this point the account already exists, so say that
      // instead of leaving the button stuck on loading.
      const { createClient } = await import("@/lib/supabase/client");
      supabase = createClient();
    } catch {
      setError("Your account was created, but sign-in couldn't load. Go to Log in and use your new password.");
      setLoading(false);
      return;
    }
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
    // bounce the user back to /login). ?next is read here at submit time —
    // see the SignupCard doc comment for why not useSearchParams.
    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    window.location.assign(next ?? "/dashboard");
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
          onFocus={() => {
            // Warm the lazily-loaded supabase-js chunk (see onSubmit) so
            // the submit click doesn't stall on a network fetch.
            void import("@/lib/supabase/client").catch(() => {});
          }}
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
