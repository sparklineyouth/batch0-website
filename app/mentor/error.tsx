"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** Boundary for the mentor panel — keeps the mentor sidebar mounted. */
export default function MentorError({
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
      body="This page failed to load. The error has been reported — try again, or go back to your students."
      homeHref="/mentor"
      homeLabel="Back to mentor panel"
    />
  );
}
