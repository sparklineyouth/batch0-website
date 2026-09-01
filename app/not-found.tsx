import type { Metadata } from "next";
import Navbar from "@/components/navbar";
import { NotFoundScreen } from "@/components/ui/not-found-screen";

export const metadata: Metadata = {
  title: "Not found · batch0",
  // A 404 that gets indexed competes with the page it replaced. Next already
  // serves the correct status; this stops the body from earning a listing.
  robots: { index: false, follow: false },
};

/**
 * The site-wide 404 — every URL that matches no route, plus any `notFound()`
 * thrown outside a segment that carries its own boundary.
 *
 * `<Navbar />` renders with its default `cohortLabel` rather than one read from
 * site config. That is deliberate: resolving the real label means a database
 * read, a database read makes this route dynamic, and a 404 is the single page
 * most likely to be hit by a crawler hammering dead links. It stays static, and
 * the copy on it never mentions a cohort.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <Navbar />
      <main id="main-content" tabIndex={-1}>
        <NotFoundScreen
          body="The page you're after doesn't exist, or it moved. Nothing is broken — the link just doesn't point anywhere anymore."
          secondary={{ href: "/program", label: "See the program" }}
        />
      </main>
    </div>
  );
}
