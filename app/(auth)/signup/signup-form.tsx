"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";

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
      setError(error.message);
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

  if (needsVerify) {
    return (
      <div className="mt-6 rounded-lg border border-spark/30 bg-spark/5 p-4 text-sm text-white/80">
        <p className="font-medium text-spark">Check your email</p>
        <p className="mt-1 text-white/60">
          We sent a verification link to <span className="text-white">{email}</span>. Click it to activate your account, then log in.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <div>
        <Label htmlFor="fullName">Full name</Label>
        <Input
          id="fullName"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-white/40">At least 8 characters.</p>
      </div>
      <FieldError>{error}</FieldError>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
