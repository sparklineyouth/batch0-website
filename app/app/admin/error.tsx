"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** Boundary for the installed admin app — keeps the tab bar mounted. */
export default function AdminAppError({
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
      body="This screen failed to load. The error has been reported — try again, or head back to Today."
      homeHref="/app/admin"
      homeLabel="Go to Today"
    />
  );
}
