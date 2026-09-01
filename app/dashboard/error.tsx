"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * Boundary for the student dashboard. Catching here keeps the sidebar and
 * mobile nav mounted (they come from the layout above this file), so one
 * failed query leaves the user inside the product with a retry, instead of
 * dropping them on the root error page with no way back but the URL bar.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorScreen
      error={error}
      reset={reset}
      variant="inline"
      body="This part of your dashboard failed to load. The error has been reported — try again, or go back to the overview."
      homeHref="/dashboard"
      homeLabel="Back to dashboard"
    />
  );
}
