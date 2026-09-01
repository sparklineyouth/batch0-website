/**
 * Streaming boundary for the investor area.
 *
 * Same reasoning as app/admin/loading.tsx: the overview and team pages are
 * dynamic multi-query renders, and without a boundary navigation gives zero
 * feedback for their full TTFB. The sidebar lives in the layout, so this only
 * needs the content pane: heading, the three-tile stat row the overview leads
 * with, then stacked team-style cards — matching the real geometry keeps the
 * swap still.
 *
 * Neutral tokens (bg-wash / border-line) so it reads correctly in both themes.
 */
export default function InvestorLoading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse" aria-hidden>
      <div className="h-9 w-64 rounded bg-wash" />
      <div className="mt-3 h-4 w-full max-w-md rounded bg-wash" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line p-4">
            <div className="h-3 w-24 rounded bg-wash" />
            <div className="mt-3 h-8 w-16 rounded bg-wash" />
          </div>
        ))}
      </div>
      <div className="mt-10 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line p-5">
            <div className="h-5 w-40 rounded bg-wash" />
            <div className="mt-3 h-4 w-full max-w-sm rounded bg-wash" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
