/**
 * The instant frame a screen shows while its data is in flight.
 *
 * This is the app's single biggest responsiveness win, and it is not a
 * micro-optimisation. Every /app route is `force-dynamic` and reads Supabase,
 * so a tab tap used to hold the previous screen on-frame for the whole round
 * trip and then swap — which reads as "nothing happened, then everything
 * happened". With a loading boundary Next paints this immediately on tap and
 * streams the real content in behind it, so the app responds within a frame
 * whatever the database is doing.
 *
 * It also changes what the tab bar can prefetch: for a route with a loading
 * boundary Next prefetches the static shell, which `staleTimes.dynamic = 0`
 * does not invalidate. See the note in tab-bar.tsx.
 *
 * The shapes deliberately match the real layout's metrics — same header height,
 * same 3.875rem rows, same 7rem stat tiles. A skeleton whose boxes don't line
 * up with what replaces them produces a visible jolt, which is worse than no
 * skeleton at all.
 *
 * `animate-pulse` is Tailwind's built-in opacity animation: composited, no
 * JavaScript, and globals.css already disables animation under
 * prefers-reduced-motion.
 */
function Bar({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-wash ${className}`} />;
}

/** Header + body skeleton. `rows` and `tiles` shape it to the target screen. */
export function ScreenSkeleton({
  tiles = 0,
  rows = 4,
}: {
  /** Stat tiles above the list, rendered as a 2-up grid. */
  tiles?: number;
  /** List rows below. */
  rows?: number;
}) {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {/* Matches AppHeader's box exactly so the real header doesn't jump in. */}
      <div className="sticky top-0 z-30 border-b border-line bg-paper pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 px-5 pb-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Bar className="h-2.5 w-24" />
            <Bar className="mt-2.5 h-6 w-44" />
          </div>
          <Bar className="h-9 w-9 rounded-lg" />
        </div>
      </div>

      <div className="px-5 pt-7 sm:px-6">
        {tiles > 0 && (
          <>
            <Bar className="h-2.5 w-28" />
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              {Array.from({ length: tiles }).map((_, i) => (
                <div
                  key={i}
                  className="min-h-[7rem] rounded-2xl border border-line bg-wash/60 px-4 py-4"
                >
                  <Bar className="h-2.5 w-16 bg-line" />
                  <Bar className="mt-3 h-7 w-12 bg-line" />
                </div>
              ))}
            </div>
          </>
        )}

        <div className={tiles > 0 ? "mt-10" : ""}>
          <Bar className="h-2.5 w-24" />
          <div className="mt-4 rounded-2xl border border-line px-4 sm:px-5">
            {Array.from({ length: rows }).map((_, i) => (
              <div
                key={i}
                className="flex min-h-[3.875rem] items-center gap-3.5 border-b border-line py-3.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <Bar className={`h-3.5 ${i % 2 ? "w-40" : "w-52"}`} />
                  <Bar className="mt-2 h-2.5 w-24" />
                </div>
                <Bar className="h-4 w-4 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Screen readers get one honest message instead of a pile of empty
          boxes; the visual skeleton is aria-hidden above. */}
      <p className="sr-only" role="status">
        Loading
      </p>
    </div>
  );
}
