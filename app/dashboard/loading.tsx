/**
 * Streaming boundary for the student dashboard.
 *
 * Same reasoning as app/admin/loading.tsx: without a boundary anywhere in the
 * tree, Next has to finish every query in the page before it can flush any
 * markup, so the sidebar the layout already knows how to draw waits on data it
 * does not need. This lets the chrome paint first and the page stream in.
 *
 * Neutral tokens (bg-wash / border-line) so it reads correctly in both themes,
 * and the same max-width and rhythm as the real pages so the swap is still.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse" aria-hidden>
      {/* Mirrors the real hero row in page.tsx block for block, because the
          swap has to be still. Measured in a browser against a live
          dashboard: eyebrow 17 + (mt-3 + h1 48) + (mt-3 + lede 24) +
          (mt-6 + CTA 40) + pb-8 = 210px, and the grid below starts after
          mt-10. The old skeleton was 64px and used mt-8, so the entire
          Program/Quick-links grid dropped ~154px the instant content
          arrived — which is most of what "the dashboard feels broken"
          actually is. h1 and the lede change size at md, so the skeleton
          does too. */}
      <div className="border-b border-line pb-8">
        <div className="h-4 w-40 rounded bg-wash" />
        <div className="mt-3 h-10 w-64 rounded bg-wash md:h-12 md:w-80" />
        <div className="mt-3 h-12 w-full max-w-xl rounded bg-wash md:h-6" />
        <div className="mt-6 h-10 w-44 rounded-md bg-wash" />
      </div>
      <div className="mt-10 grid gap-10 md:grid-cols-12">
        <div className="space-y-3 md:col-span-7">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md border border-line" />
          ))}
        </div>
        <div className="space-y-2 md:col-span-5">
          <div className="h-3 w-28 rounded bg-wash" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-11 rounded-md border border-line" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
