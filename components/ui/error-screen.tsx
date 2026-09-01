"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";
import { Fallback } from "./fallback";
import { buttonClasses } from "./button";

/**
 * The body of every `error.tsx` in the app.
 *
 * Next only walks up to the *nearest* error boundary, so a segment that has one
 * keeps its layout — the sidebar, the tab bar, the nav — and only the content
 * column is replaced. Before these existed the single root boundary caught
 * everything, which meant one failed query anywhere under /admin or /dashboard
 * tore the whole shell down and dropped the user on a bare marketing-shaped
 * page with no way back into the product except the browser's back button.
 *
 * The reset button is the reason a boundary is worth having at all: most of
 * what fails here is a transient read (a cold Supabase connection, a Discord
 * call that timed out), and `reset()` re-renders the segment in place without a
 * full document load, so a retry costs nothing and usually works.
 *
 * Reporting stays here rather than in each boundary so no future segment can
 * ship an error screen that silently swallows its error.
 */
export function ErrorScreen({
  error,
  reset,
  title = "We hit a snag.",
  body = "This page failed to load. The error has been reported — try again, or head back.",
  homeHref = "/",
  homeLabel = "Go home",
  variant = "page",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  body?: string;
  /** Where "back" goes. Segment boundaries point at their own home, not "/". */
  homeHref?: string;
  homeLabel?: string;
  variant?: "page" | "inline";
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <Fallback
      variant={variant}
      eyebrow="Something broke"
      title={title}
      body={body}
      icon={<AlertTriangle className="h-7 w-7" aria-hidden />}
      reference={error.digest}
      actions={
        <>
          <button onClick={reset} className={buttonClasses("primary", "md")}>
            Try again
          </button>
          <Link href={homeHref} className={buttonClasses("secondary", "md")}>
            {homeLabel}
          </Link>
        </>
      }
    />
  );
}
