"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * /notifications has no layout of its own, so this renders on the bare root
 * shell — "page" variant, and the way back is the dashboard rather than the
 * marketing homepage, because everyone who reaches this route is signed in.
 */
export default function NotificationsError({
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
      body="We couldn't load your notifications. The error has been reported — try again, or go back to your dashboard."
      homeHref="/dashboard"
      homeLabel="Back to dashboard"
    />
  );
}
