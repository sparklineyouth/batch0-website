"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function PortalButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function open() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Failed");
      window.location.href = data.url;
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={open} disabled={loading}>
        {loading ? "Opening…" : "Manage billing"}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
