"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** Boundary for the admin panel — keeps the admin sidebar mounted. */
export default function AdminError({
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
      body="This admin page failed to load. The error has been reported — try again, or go back to the panel."
      homeHref="/admin"
      homeLabel="Back to admin"
    />
  );
}
