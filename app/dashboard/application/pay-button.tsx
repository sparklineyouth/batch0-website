"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

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
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <div>
      <Button onClick={pay} disabled={loading}>
        {loading ? "Redirecting…" : "Pay & enroll →"}
      </Button>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
