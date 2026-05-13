"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";

export function ChargePayButton({
  chargeId,
  label = "Pay now",
}: {
  chargeId: string;
  label?: string;
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
        body: JSON.stringify({ chargeId }),
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
    <div className="flex flex-col items-end gap-1">
      <Button onClick={pay} disabled={loading} size="sm">
        {loading ? "Redirecting…" : label}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
