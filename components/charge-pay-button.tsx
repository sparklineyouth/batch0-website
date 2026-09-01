"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";

export function ChargePayButton({
  chargeId,
  label = "Pay now",
  size = "sm",
  fullWidth = false,
  returnTo = "dashboard",
}: {
  chargeId: string;
  label?: string;
  /**
   * Which surface to come back to after Stripe. A key, not a path — the API
   * resolves it against a fixed allowlist, because the value ends up in a
   * redirect back into our own origin and a caller-supplied URL there is an
   * open redirect. The installed app passes "app"; every desktop call site
   * keeps the default and is unchanged.
   */
  returnTo?: "app" | "dashboard";
  /**
   * Both of these default to what the component already did, because it is
   * shared with three desktop routes (/dashboard, /dashboard/billing,
   * /dashboard/pay-fine) where a 32px right-aligned button is correct next to
   * a table cell. Changing the shape in place would have moved all four call
   * sites to satisfy one. The installed app passes `size="lg" fullWidth` — a
   * 48px bar with 16px text, since on a phone this is the action that unblocks
   * a fine-locked account rather than one control among many.
   */
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function pay() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/stripe/charge-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chargeId, returnTo }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Could not start checkout");
      window.location.href = data.url;
    } catch (e: any) {
      setError(getActionError(e));
      setLoading(false);
    }
  }

  return (
    <div
      className={`flex flex-col gap-1 ${
        fullWidth ? "items-stretch" : "items-end"
      }`}
    >
      <Button
        onClick={pay}
        disabled={loading}
        aria-busy={loading}
        size={size}
        className={fullWidth ? "w-full" : ""}
      >
        {loading ? "Opening checkout…" : label}
      </Button>
      {/* Stays disabled through the redirect — a second click here would
          open a second Stripe session for the same charge. */}
      {loading && (
        <p className="text-xs text-ink-faint">Taking you to Stripe…</p>
      )}
      {/* The explicit light/dark pair every other status colour in this app
          uses, rather than the bare `text-red-400` this was. That class only
          reads on paper because globals.css remaps it under `.theme-light`,
          which next-themes puts on <html> — so the colour was correct but
          came from a compatibility layer for dark-authored markup two files
          away, and #f87171 is ~2.8:1 on white the moment that layer moves. */}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
