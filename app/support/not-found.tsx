import type { Metadata } from "next";
import { Compass } from "lucide-react";
import Navbar from "@/components/navbar";
import { Fallback } from "@/components/ui/fallback";
import { buttonClasses } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Not found · batch0",
  robots: { index: false, follow: false },
  // This renders at /support/t/<whatever was in the link>, so it carries the
  // thread page's rule: no Referer off it.
  referrer: "no-referrer",
};

/**
 * The 404 for an emailed thread link that opens nothing.
 *
 * One page for every way that happens — a token that was never issued, one
 * that's malformed, a link cut short by a mail client — and deliberately
 * nothing that varies between them: no "this request was closed", no echo of
 * the link. Telling those cases apart would tell someone guessing at tokens
 * when they were close.
 *
 * Plain anchors rather than next/link: the URL this renders under has the
 * shape of a secret, and a full page load leaves no client-side history
 * behind it. Renders its own Navbar, like app/blog/not-found.tsx, because
 * /support has no layout of its own.
 */
export default function SupportNotFound() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <Navbar />
      <main id="main-content" tabIndex={-1}>
        <Fallback
          eyebrow="404"
          title="We can't open that request."
          body="This link doesn't lead to a support request. If you copied it from an email, open it straight from the email again. Signed in, all of your requests are on your support page."
          icon={<Compass className="h-7 w-7" aria-hidden />}
          actions={
            <>
              <a href="/dashboard/support" className={buttonClasses("primary", "md")}>
                Your requests
              </a>
              <a href="/support" className={buttonClasses("secondary", "md")}>
                Start a new request
              </a>
            </>
          }
        />
      </main>
    </div>
  );
}
