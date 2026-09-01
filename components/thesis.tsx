import React from "react";
import { ThemedImage } from "@/components/themed-image";
import { Section, Eyebrow, Fig } from "@/components/section-kit";

/**
 * The thesis — ONE loud thing, with the tree as its anchor.
 *
 * The tree used to be absolutely positioned across the whole section,
 * which let the canopy run under the statement's right edge. It now
 * holds its own column of the shared grid like every other anchor, so
 * nothing collides — but it is still allowed to break its column with
 * negative margins and keeps the radial dissolve, so it reads as sitting
 * IN the page rather than parked in a cell.
 *
 * The tracer is "company." — the word the argument lands on — and it
 * rhymes with the amber zero at the tree's root. It uses the reactive
 * phosphor token, not literal #FFBB00: on cream, flat amber is far below
 * AA as text. The zero in the art stays literal amber; it is art.
 */

const BEATS: { from: string; to: string }[] = [
  { from: "an idea", to: "something someone will pay for" },
  { from: "a landing page", to: "a product with users on it" },
  { from: "a hunch", to: "a company with your name on the cap table" },
];

export default function Thesis() {
  return (
    <Section id="thesis">
      <div className="grid grid-cols-12 items-center gap-x-6 gap-y-14">
        {/* ── statement ──────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-7">
          <Eyebrow>the thesis</Eyebrow>

          <h2 className="sec-display mt-6 max-w-[13ch]">
            come in with an idea. leave with a{" "}
            <span className="text-phosphor">company.</span>
          </h2>

          <p className="sec-lead mt-8 max-w-[42ch]">
            Nine weeks. Long enough to build the thing, short enough that you
            cannot spend it planning.
          </p>
        </div>

        {/* ── anchor ─────────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-5">
          <div className="mx-auto max-w-[22rem] md:max-w-none md:-mr-[12%]">
            <ThemedImage
              night="/tree-night.png"
              day="/tree-day.png"
              alt=""
              width={1254}
              height={1254}
              sizes="(max-width: 768px) 74vw, 460px"
              className="plate-feather plate-radial h-auto w-full"
            />
            <Fig n="03" className="mt-2 md:-mt-2">
              nine weeks, from seed to canopy
            </Fig>
          </div>
        </div>
      </div>

      {/* ── the escalation, clearly secondary ──────────────────── */}
      <dl className="mt-16 max-w-[38rem]">
        {BEATS.map((b, i) => (
          <div
            key={b.from}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-3.5 last:border-b"
          >
            <span
              aria-hidden
              className="font-display text-[15px] leading-none text-ink-faint"
            >
              0{i + 1}
            </span>
            <dt className="sec-body text-ink-faint">{b.from}</dt>
            <span aria-hidden className="text-[13px] text-ink-faint">→</span>
            <dd className="text-[15px] font-medium leading-[1.5] text-ink">
              {b.to}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
