"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";

export function PayButton({ applicationId }: { applicationId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function pay() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId }),
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
    <div>
      <Button onClick={pay} disabled={loading} aria-busy={loading}>
        {loading ? "Opening secure checkout…" : "Pay & enroll →"}
      </Button>
      {/* `loading` stays true through the redirect — say why the page is
          sitting there so nobody double-clicks into a second checkout. */}
      <p className="mt-2 text-xs text-ink-faint">
        {loading
          ? "Taking you to Stripe — don't close this tab."
          : "Card payment handled by Stripe. You'll come straight back here with a confirmation."}
      </p>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
