import type { Metadata } from "next";
import { WifiOff } from "lucide-react";

export const metadata: Metadata = {
  title: "Offline · batch0",
  robots: { index: false, follow: false },
};

/**
 * The one page public/sw.js caches. It must stay fully static and read nothing
 * about the visitor — it is served from the device to whoever is holding it,
 * with no network available to check who that is.
 *
 * There is no "Retry" link, deliberately: a <Link> would try to prefetch and a
 * plain reload button is what actually works with no connection. The user's own
 * pull-to-refresh does the same job with a gesture they already know.
 */
export default function OfflinePage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-[100dvh] flex-col items-center justify-center bg-paper px-6 text-center text-ink"
    >
      <WifiOff className="h-8 w-8 text-ink-faint" />
      <h1 className="mt-6 font-display text-3xl tracking-[-0.02em] text-ink">
        No connection
      </h1>
      <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-soft">
        batch0 needs a network to show you anything current, and stale cohort
        data is worse than none. Reconnect and pull down to refresh.
      </p>
      <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-faint">
        batch<span className="text-phosphor-ink">0</span>
      </p>
    </main>
  );
}
