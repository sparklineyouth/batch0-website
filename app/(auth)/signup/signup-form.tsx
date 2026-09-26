"use client";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
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
 * way the heading, the full form, and the login link are all in the static
 * shell.
 *
 * The heading is the SAME in both variants on purpose: the apply-flow copy
 * can only swap in after hydration, and a big display headline changing under
 * the reader a beat after the page paints looks like a glitch. Only the small
 * step marker and the supporting line differ.
 */
export function SignupCard() {
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
      <p className="h-4 font-mono text-xs uppercase tracking-[0.18em] text-phosphor-ink">
        {isApplyFlow ? "Step 1 of 2 · Your account" : ""}
      </p>
      <h1 className="mt-4 font-display text-[clamp(2.5rem,9vw,3.25rem)] leading-[1.04] text-ink">
        Create your free account.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
        {isApplyFlow ? (
          <>
            It saves your application as you go. Next: a few short questions about you and what you
            want to build. Applying is free — tuition is charged only if you&apos;re accepted, and
            you&apos;ll see each cohort&apos;s price before you choose.
          </>
        ) : (
          <>Save your progress, then apply when you&apos;re ready or explore your dashboard. No payment needed.</>
        )}
      </p>
      <SignupForm applying={isApplyFlow} />
      <p className="mt-8 text-sm text-ink-soft">
        Already have an account?{" "}
        <Link href={loginHref} className="link-ink">
          Log in
        </Link>
      </p>
      <p className="mt-3 text-sm text-ink-faint">
        <Link href="/parents" className="hover:text-ink">
          Tuition, calendar &amp; parent guide →
        </Link>
      </p>
    </div>
  );
}

// `!` because Input's own `md:text-sm` is emitted later in Tailwind's output
// and would otherwise win at the same specificity.
const FIELD = "h-12 text-base md:!text-base";

export function SignupForm({ applying = false }: { applying?: boolean }) {
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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Its own state, so "tell us your name" marks the NAME field — the shared
  // `error` is wired to the password input, where server errors belong.
  const [nameError, setNameError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The two checks worth making before a round trip: the name is what the
    // application's first question is prefilled with, and the password rule
    // is the server's own (signUpAction) — no reason to wait to hear it.
    if (!fullName.trim()) {
      setError(undefined);
      setNameError("Tell us your name.");
      document.getElementById("fullName")?.focus();
      return;
    }
    setNameError(undefined);
    if (password.length < 8) {
      setError("Pick a password with at least 8 characters.");
      return;
    }
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
    track("signup_completed", { destination: applying ? "application" : "dashboard" });
    window.location.assign(next ?? "/dashboard");
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
      <div>
        <Label htmlFor="fullName" required>
          Full name
        </Label>
        <Input
          id="fullName"
          autoComplete="name"
          required
          aria-required="true"
          error={nameError}
          value={fullName}
          onChange={(e) => {
            setFullName(e.target.value);
            if (nameError) setNameError(undefined);
          }}
          onFocus={() => {
            // Warm the lazily-loaded supabase-js chunk (see onSubmit) so
            // the submit click doesn't stall on a network fetch.
            void import("@/lib/supabase/client").catch(() => {});
          }}
          className={FIELD}
        />
        <FieldError id="fullName-error">{nameError}</FieldError>
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
          className={FIELD}
        />
      </div>
      <div>
        <Label htmlFor="password" required>
          Password
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            minLength={8}
            required
            aria-required="true"
            aria-describedby="password-hint signup-error"
            error={error ? true : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${FIELD} pr-12`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-phosphor"
          >
            {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        <p id="password-hint" className="mt-1.5 text-xs text-ink-faint">
          At least 8 characters. Use letters and numbers — avoid common words.
        </p>
      </div>
      <FieldError id="signup-error">{error}</FieldError>
      <button
        type="submit"
        disabled={loading}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-phosphor px-6 text-base font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Creating your account…
          </>
        ) : (
          <>
            {applying ? "Create account & continue" : "Create account"}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </>
        )}
      </button>
      <p className="text-xs leading-relaxed text-ink-faint">
        By creating an account you agree to our{" "}
        <a href="/terms" className="underline underline-offset-2 hover:text-ink">
          Terms
        </a>{" "}
        and{" "}
        <a href="/privacy" className="underline underline-offset-2 hover:text-ink">
          Privacy Policy
        </a>
        .
      </p>
    </form>
  );
}
