"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * Boundary for the installed student app. Keeping it here rather than letting
 * the root boundary catch matters more on a phone than anywhere else: the tab
 * bar lives in the layout, so a nested catch leaves the user with their four
 * tabs and a retry, while a root catch leaves a standalone PWA window with no
 * navigation at all and no browser chrome to escape through.
 */
export default function StudentAppError({
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
      body="This screen failed to load. The error has been reported — pull up a retry, or head back to Home."
      homeHref="/app/home"
      homeLabel="Go to Home"
    />
  );
}
