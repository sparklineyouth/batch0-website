import React from "react";

/**
 * The video slot — a terminal-framed plate where the explainer will go.
 *
 * There is no video yet, so this is deliberately NOT a <button>: a control
 * that announces itself to a screen reader and then does nothing is worse
 * than an inert figure. It is a <figure> with the play mark marked
 * aria-hidden and a real caption; when the file lands, this becomes a
 * button (or the <video> itself) and the affordance starts telling the
 * truth. Nothing here is interactive in the meantime.
 */
export default function VideoPlate() {
  return (
    <section id="video" className="border-t border-line py-14 md:py-20">
      <p className="section-intro">the short version, once we&apos;ve filmed it.</p>

      <figure className="mt-6">
        <div className="relative mx-auto aspect-video w-full max-w-[860px] border border-line bg-wash">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            {/* Play mark — off-white; the amber belongs to the CTA. */}
            <span
              aria-hidden
              className="block h-0 w-0 border-y-[13px] border-l-[22px] border-y-transparent border-l-ink-faint"
            />
          </div>
        </div>

        <figcaption className="t-small mt-3 text-ink-faint">
          a two-minute look at how the cohort runs.
        </figcaption>
      </figure>
    </section>
  );
}
