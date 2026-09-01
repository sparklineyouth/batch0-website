"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current server route on an interval, a bounded number of
 * times. Used while a payment is still clearing: the page that greets a
 * student back from Stripe Checkout re-reads its own state until the
 * payment settles, so nobody has to know to hit reload.
 *
 * Stops on its own after `attempts` tries — an indefinitely spinning page
 * is worse than one that tells you to check back.
 */
export function AutoRefresh({
  intervalMs = 3000,
  attempts = 10,
}: {
  intervalMs?: number;
  attempts?: number;
}) {
  const router = useRouter();
  const [left, setLeft] = useState(attempts);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => {
      setLeft((n) => n - 1);
      router.refresh();
    }, intervalMs);
    return () => clearTimeout(t);
  }, [left, intervalMs, router]);

  return null;
}
