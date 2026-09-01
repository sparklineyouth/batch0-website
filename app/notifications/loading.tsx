/**
 * Streaming boundary for the notifications inbox.
 *
 * Same reasoning as app/dashboard/loading.tsx: the page resolves auth, the
 * role home, and the notifications list before it can flush anything, and
 * it's linked from the bell on every screen — without a boundary the click
 * gives zero feedback until all of that finishes.
 *
 * Mirrors the page's own chrome (full-height paper, header bar, centered
 * column) in neutral tokens so the swap is still in both themes.
 */
export default function NotificationsLoading() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <div className="h-5 w-16 rounded bg-wash" />
        </div>
      </div>
      <main
        className="mx-auto max-w-3xl animate-pulse px-5 py-10 md:px-8 md:py-14"
        aria-hidden
      >
        <div className="h-3 w-16 rounded bg-wash" />
        <div className="mt-3 h-9 w-64 rounded bg-wash" />
        <div className="mt-10 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md border border-line" />
          ))}
        </div>
        <span className="sr-only">Loading</span>
      </main>
    </div>
  );
}
