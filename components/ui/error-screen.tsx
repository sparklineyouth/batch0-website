"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";
import { sanitizeContextPage } from "@/lib/support-access";
import { Fallback } from "./fallback";
import { buttonClasses } from "./button";

/** The digest shape the support form keeps; anything else is left off the link. */
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where "Report this problem" goes: the support form, preset to Tech help,
 * carrying the page that broke and the error's digest so whoever answers can
 * find the exact failure in Sentry instead of asking "what were you doing?".
 *
 * /support rather than /dashboard/support/new, for two reasons. The root
 * boundary renders for signed-out visitors too, and /support handles them
 * (and carries these params through the login). And when a product shell is
 * what's failing, its own support page may fail the same way; /support sits
 * outside every product shell, under the marketing chrome, so it doesn't
 * share whatever broke the dashboard's or the admin's layout.
 *
 * The pathname goes through sanitizeContextPage before it touches the URL.
 * This screen renders on the token-in-the-path pages (/support/t/<token>,
 * /demo-day/ticket/<token>) like any other, and an unfiltered `from` would
 * copy that secret into the support link's own URL — and from there into
 * analytics and the Referer header.
 */
function reportHref(pathname: string | null, digest: string | undefined): string {
  const q = new URLSearchParams({ topic: "technical" });
  const from = sanitizeContextPage(pathname);
  if (from) q.set("from", from);
  if (digest && DIGEST_PATTERN.test(digest)) q.set("digest", digest);
  q.set("source", "error_screen");
  return `/support?${q.toString()}`;
}

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

  // usePathname rather than window.location: it reads the same on the server
  // and in the browser, so the link is right on the first render — no effect,
  // nothing for hydration to disagree about.
  const pathname = usePathname();

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
          {/* A help affordance, not a third action: most of what fails here
              is transient and "Try again" fixes it, so this sits on its own
              full-width row under the buttons (basis-full in the actions'
              flex-wrap), in small type, for when retrying hasn't.

              A plain <a>, never next/link. This screen can be showing on a
              secret URL, and a client-side navigation away from one leaves
              a history entry analytics can read; a full page load doesn't.
              It's also the better reload after a failure — whatever state
              broke this page doesn't come along to the next one.

              rel="noreferrer" for the same secret URL: the token pages set
              no-referrer in their own metadata, which can't be counted on
              once that page is the thing that failed, and without it the
              token would arrive on /support as document.referrer — where
              analytics is running. */}
          <p className="basis-full text-xs text-ink-soft">
            Keeps happening?{" "}
            <a
              href={reportHref(pathname, error.digest)}
              rel="noreferrer"
              className="underline decoration-line underline-offset-2 hover:text-ink hover:decoration-phosphor"
            >
              Report this problem
            </a>
          </p>
        </>
      }
    />
  );
}
