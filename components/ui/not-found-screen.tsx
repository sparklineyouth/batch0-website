import Link from "next/link";
import { Compass } from "lucide-react";
import { Fallback } from "./fallback";
import { buttonClasses } from "./button";

/**
 * The body of every `not-found.tsx`.
 *
 * There are ~34 `notFound()` calls across the app — a deleted cohort, a
 * submission that belongs to someone else, a blog slug that was renamed — and
 * until these boundaries existed every one of them rendered Next's built-in
 * 404: a bare white page with system-font text, no chrome, no theme, and no
 * link back. That page is jarring anywhere, and inside the product it reads as
 * a hard crash rather than "this row is gone."
 *
 * Like the error boundaries, a `not-found.tsx` inside a segment renders within
 * that segment's layout, so the sidebar stays put and the user is one click
 * from somewhere real.
 */
export function NotFoundScreen({
  title = "We can't find that.",
  body = "The page you're after doesn't exist, or it moved. Nothing is broken — the link just doesn't point anywhere anymore.",
  homeHref = "/",
  homeLabel = "Go home",
  secondary,
  variant = "page",
}: {
  title?: string;
  body?: string;
  homeHref?: string;
  homeLabel?: string;
  /** Optional extra action, e.g. a link to the segment's index list. */
  secondary?: { href: string; label: string };
  variant?: "page" | "inline";
}) {
  return (
    <Fallback
      variant={variant}
      eyebrow="404"
      title={title}
      body={body}
      icon={<Compass className="h-7 w-7" aria-hidden />}
      actions={
        <>
          <Link href={homeHref} className={buttonClasses("primary", "md")}>
            {homeLabel}
          </Link>
          {secondary && (
            <Link
              href={secondary.href}
              className={buttonClasses("secondary", "md")}
            >
              {secondary.label}
            </Link>
          )}
        </>
      }
    />
  );
}
