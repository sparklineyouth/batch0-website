/**
 * Streaming boundary for the mentor area.
 *
 * Same reasoning as app/admin/loading.tsx: every mentor page is dynamic
 * multi-query work, and without a boundary the previous page stays frozen
 * until the whole query chain resolves. The sidebar lives in the layout, so
 * this only needs the content pane: heading, the four-tile stat grid the
 * overview leads with, then a list card — matching the real geometry keeps
 * the swap still.
 *
 * Neutral tokens (bg-wash / border-line) so it reads correctly in both themes.
 */
export default function MentorLoading() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse" aria-hidden>
      <div className="h-9 w-64 rounded bg-wash" />
      <div className="mt-3 h-4 w-full max-w-md rounded bg-wash" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line p-4">
            <div className="h-3 w-24 rounded bg-wash" />
            <div className="mt-3 h-8 w-16 rounded bg-wash" />
          </div>
        ))}
      </div>
      <div className="mt-10 rounded-lg border border-line p-5">
        <div className="h-5 w-32 rounded bg-wash" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded border border-line" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
