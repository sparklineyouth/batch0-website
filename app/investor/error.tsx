"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** Boundary for the investor room — keeps the investor sidebar mounted. */
export default function InvestorError({
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
      body="This page failed to load. The error has been reported — try again, or go back to the teams list."
      homeHref="/investor"
      homeLabel="Back to the investor room"
    />
  );
}
