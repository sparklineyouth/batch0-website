"use client";
import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { friendlyAuthError } from "@/lib/auth-errors";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/reset`,
    });
    if (error) {
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }
    setSent(true);
    setLoading(false);
  }

  return (
    <div>
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
    </div>
  );
}
