import React from "react";
import { Section, Eyebrow, Fig } from "@/components/section-kit";

/**
 * The video slot. There is no film yet, so this is an explicit,
 * finished-looking PLACEHOLDER rather than an empty box — the previous
 * version was an unbordered grey rectangle floating in space, which
 * read as a broken embed.
 *
 * Deliberately NOT a <button>: a control that announces itself to a
 * screen reader and then does nothing is worse than an inert figure.
 * It is a <figure> with an aria-hidden play mark and a real caption
 * that says outright the film is coming. When the file lands this
 * becomes the <video> and the affordance starts telling the truth.
 */
export default function VideoPlate() {
  return (
    <Section id="video">
      <div className="mx-auto max-w-[62rem]">
        <Eyebrow>the short version</Eyebrow>

        <figure className="mt-6">
          <div className="relative aspect-video w-full overflow-hidden border border-line bg-wash">
            {/* centre mark */}
            <div className="absolute inset-0 flex items-center justify-center">
              <span
                aria-hidden
                className="flex h-14 w-14 items-center justify-center rounded-full border border-line"
              >
                <span className="ml-[3px] block h-0 w-0 border-y-[9px] border-l-[15px] border-y-transparent border-l-ink-faint" />
              </span>
            </div>
            {/* corner ticks — the plate reads as a framed plate, not a void */}
            {[
              "left-0 top-0 border-l border-t",
              "right-0 top-0 border-r border-t",
              "bottom-0 left-0 border-b border-l",
              "bottom-0 right-0 border-b border-r",
            ].map((c) => (
              <span key={c} aria-hidden className={`absolute h-3 w-3 border-ink-faint/45 ${c}`} />
            ))}
          </div>

          <figcaption className="mt-4">
            <Fig n="01">
              a two-minute look at how the cohort runs — coming soon
            </Fig>
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}
