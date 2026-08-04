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
      <p className="cmdline font-mono">
        <b>./what-is-batch0.mp4</b>{" "}
        <span className="mtime">· 2 min</span>
      </p>
      <p className="cmd-sub">the ninety-second version, if you prefer it.</p>

      <figure className="mt-6">
        <div className="relative mx-auto aspect-video w-full max-w-[860px] border border-line bg-wash">
          {/* corner ticks — the plate reads as a framed terminal region */}
          <span aria-hidden className="absolute left-0 top-0 h-2 w-2 border-l border-t border-ink-faint" />
          <span aria-hidden className="absolute right-0 top-0 h-2 w-2 border-r border-t border-ink-faint" />
          <span aria-hidden className="absolute bottom-0 left-0 h-2 w-2 border-b border-l border-ink-faint" />
          <span aria-hidden className="absolute bottom-0 right-0 h-2 w-2 border-b border-r border-ink-faint" />

          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            {/* Pixel play mark: a stepped triangle, same blockiness as the
                icon set. Off-white — the amber belongs to the CTA. */}
            <span
              aria-hidden
              className="block h-0 w-0 border-y-[13px] border-l-[22px] border-y-transparent border-l-ink-faint"
            />
            <span className="t-small font-mono text-ink-faint">
              standing by · no signal
            </span>
          </div>
        </div>

        <figcaption className="t-small mt-3 font-mono text-ink-faint">
          $ ./what-is-batch0.mp4
        </figcaption>
      </figure>
    </section>
  );
}
