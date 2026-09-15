"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";

/**
 * The one button on the public ticket page. Mirrors ChargePayButton, but
 * hands the ticket's secret token to the ticket checkout route instead of a
 * charge id — there is no signed-in user here to own anything.
 */
export function TicketPayButton({
  token,
  label,
}: {
  token: string;
  label: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function pay() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/stripe/demo-day-ticket-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (e: any) {
      setError(getActionError(e));
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2">
      <Button
        onClick={pay}
        disabled={loading}
        aria-busy={loading}
        size="lg"
        className="w-full"
      >
        {loading ? "Opening checkout…" : label}
      </Button>
      {/* Stays disabled through the redirect — a second click would open a
          second Stripe session for the same ticket. */}
      {loading && (
        <p className="text-center text-xs text-ink-faint">Taking you to Stripe…</p>
      )}
      {error && <p className="text-center text-xs text-red-500">{error}</p>}
    </div>
  );
}
