"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";
import { stashRefFromLocation } from "@/lib/referral-code";

/**
 * Same-origin "next" gate. Mirrors `safeNext` in app/auth/callback/route.ts;
 * keeps an attacker from coaxing the user to /login?next=https://evil.com
 * and turning the post-login redirect into an open redirect.
 */
function safeNext(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

/**
 * ?next/?error are read from window.location in effects and handlers, never
 * during render. useSearchParams would be the idiomatic way, but on a static
 * route it bails the whole tree out of the prerendered HTML — an empty card
 * until hydration. Reading location imperatively keeps the full form in the
 * static shell, which is the point of /login prerendering at all.
 */
function nextFromLocation(): string | undefined {
  return safeNext(new URLSearchParams(window.location.search).get("next"));
}

// `!` because Input's own `md:text-sm` is emitted later in Tailwind's output
// and would otherwise win at the same specificity.
const FIELD = "h-12 text-base md:!text-base";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [signupHref, setSignupHref] = useState("/signup");

  // A referred visitor who already has an account bounces to /login?next=…
  // with the code nested in `next`. Stash it so the apply flow still finds
  // it even if the URL query is dropped on the way back. The ?error message
  // (set by app/auth/callback) and the ?next-carrying signup href paint one
  // frame after mount — the price of keeping the form in the static HTML.
  useEffect(() => {
    stashRefFromLocation();
    const query = new URLSearchParams(window.location.search);
    const callbackError = query.get("error");
    if (callbackError) setError(callbackError);
    const next = safeNext(query.get("next"));
    if (next) setSignupHref(`/signup?next=${encodeURIComponent(next)}`);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    let supabase;
    try {
      // supabase-js is loaded at submit time (warmed on field focus below) so
      // its ~63 kB gz chunk stays out of the login page's first-load JS. The
      // import can fail where the old static import couldn't (offline, deploy
      // skew) — surface that instead of leaving the button stuck on loading.
      const { createClient } = await import("@/lib/supabase/client");
      supabase = createClient();
    } catch {
      setError("Couldn't load the sign-in module. Check your connection and try again.");
      setLoading(false);
      return;
    }
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
    // Defense-in-depth: nextFromLocation already strips off-origin values,
    // but if that gate is ever bypassed we still refuse anything that
    // isn't a same-origin path.
    const next = nextFromLocation();
    const safe =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/dashboard";
    window.location.assign(safe);
  }

  return (
    <>
      <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
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
            // Described by the error, but not marked invalid: `error` is one
            // shared string for the whole form, so a wrong *password* used to
            // flag the email field as the bad one and send screen-reader users
            // to fix an address that was fine.
            aria-describedby={error ? "login-error" : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={FIELD}
            onFocus={() => {
              // Warm the lazily-loaded supabase-js chunk (see onSubmit) so
              // the submit click doesn't stall on a network fetch.
              void import("@/lib/supabase/client").catch(() => {});
            }}
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
            className={FIELD}
          />
        </div>
        <FieldError id="login-error">{error}</FieldError>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-phosphor px-6 text-base font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Logging in…
            </>
          ) : (
            <>
              Log in <ArrowRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </button>
      </form>
      <p className="mt-8 text-sm text-ink-soft">
        New here?{" "}
        <Link href={signupHref} className="link-ink">
          Create an account
        </Link>
      </p>
      <p className="mt-3 text-sm text-ink-faint">
        <Link href="/forgot-password" className="hover:text-ink">
          Forgot your password?
        </Link>
      </p>
    </>
  );
}
