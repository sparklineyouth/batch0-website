/**
 * Streaming boundary for the admin area.
 *
 * There wasn't one anywhere in the app — no loading.tsx, no <Suspense> — so
 * every page's data work was serialized in front of the first byte of markup.
 * On /admin that is a fan-out of counts across seven tables, and it is why the
 * panel scored worst of any route in production despite shipping almost no
 * client JS.
 *
 * With this file the sidebar and chrome paint from the layout immediately and
 * the page body streams in behind it. The skeleton deliberately matches the
 * real page's geometry — heading, then a tile grid — so nothing jumps when
 * the content lands.
 */
export default function AdminLoading() {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="h-8 w-56 rounded bg-white/10" />
      <div className="mt-3 h-4 w-80 rounded bg-white/5" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-white/10 p-4">
            <div className="h-3 w-24 rounded bg-white/5" />
            <div className="mt-3 h-7 w-16 rounded bg-white/10" />
          </div>
        ))}
      </div>
      <div className="mt-10 h-4 w-40 rounded bg-white/5" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 rounded border border-white/10" />
        ))}
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
