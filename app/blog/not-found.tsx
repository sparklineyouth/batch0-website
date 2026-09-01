import type { Metadata } from "next";
import Navbar from "@/components/navbar";
import { NotFoundScreen } from "@/components/ui/not-found-screen";

export const metadata: Metadata = {
  title: "Post not found · batch0",
  robots: { index: false, follow: false },
};

/**
 * Blog slugs and category slugs are the site's most link-rot-prone URLs — they
 * get shared, quoted, and occasionally renamed. Sending someone to the index
 * instead of the homepage is the difference between finding the retitled post
 * and giving up.
 */
export default function BlogNotFound() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* Blog pages render their own Navbar (there is no app/blog/layout.tsx),
          so this has to as well or a 404 is the one blog URL with no nav.
          Default cohortLabel keeps the route static — same reasoning as
          app/not-found.tsx. */}
      <Navbar />
      <main id="main-content" tabIndex={-1}>
        <NotFoundScreen
          title="No such post."
          body="That post doesn't exist, or its URL changed. It may still be on the blog under a different title."
          homeHref="/blog"
          homeLabel="All posts"
          secondary={{ href: "/", label: "Go home" }}
        />
      </main>
    </div>
  );
}
