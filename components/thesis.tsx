import React from "react";
import { ThemedImage } from "@/components/themed-image";

/**
 * The thesis — ONE loud thing.
 *
 * The previous pass had four elements of roughly equal weight (headline,
 * lead paragraph, escalation list, plate) and nothing commanded, which is
 * exactly why it read as generic. This version gives the section a single
 * statement at near-poster scale in VT323 and demotes everything else
 * below it: the lead is cut to one quiet line, the escalation drops to a
 * small secondary rail, and the plate stops being a boxed image on the
 * right and becomes part of the space the type sits in.
 *
 * THE TRACER. Exactly one word carries the accent — "company", the word
 * the whole argument lands on. It uses the reactive `phosphor` token
 * rather than a literal #FFBB00: on the cream paper theme flat #FFBB00
 * is far below AA as text, so the token burns it down to #8A5A00, which
 * is the same hue family and keeps the rhyme with the tree's amber zero
 * without shipping unreadable type. The zero itself stays literal
 * #FFBB00 in both themes — it is art, not text.
 *
 * THE PLATE. Absolutely positioned into the right of the section rather
 * than occupying a grid cell, deliberately larger than its column and
 * running past the container edge, with the feather opened up from 8% to
 * 22% so it dissolves into the page instead of ending. It sits behind
 * the type (z-0 against z-10) so the composition reads as one field with
 * the statement laid over it. Below md it returns to a normal stacked
 * block underneath the copy — there is no room to bleed on a phone, and
 * a half-visible tree behind text at 390 would only hurt legibility.
 */

const BEATS: { from: string; to: string }[] = [
  { from: "an idea", to: "something someone will pay for" },
  { from: "a landing page", to: "a product with users on it" },
  { from: "a hunch", to: "a company with your name on the cap table" },
];

export default function Thesis() {
  return (
    <>
      <hr className="sec-seam" />
      <section id="thesis" className="sec relative overflow-hidden font-body">
        {/* ── the plate, bled into the field ─────────────────────── */}
        <div
          aria-hidden
          className="pointer-events-none absolute right-[-14%] top-1/2 hidden w-[62%] -translate-y-1/2 md:block lg:right-[-8%] lg:w-[56%]"
        >
          <ThemedImage
            night="/tree-night.png"
            day="/tree-day.png"
            alt=""
            width={1254}
            height={1254}
            sizes="(max-width: 1024px) 62vw, 620px"
            className="plate-feather plate-radial h-auto w-full"
          />
        </div>

        {/* ── the statement ──────────────────────────────────────── */}
        <div className="relative z-10">
          <p className="sec-eyebrow">the thesis</p>

          <h2 className="sec-display mt-6 max-w-[13ch]">
            come in with an idea. leave with a{" "}
            <span className="text-phosphor">company.</span>
          </h2>

          <p className="sec-body mt-8 max-w-[40ch] text-ink-faint">
            Nine weeks. Long enough to build the thing, short enough that you
            cannot spend it planning.
          </p>
        </div>

        {/* ── the escalation, clearly secondary ──────────────────── */}
        <dl className="relative z-10 mt-14 max-w-[34rem] md:mt-20">
          {BEATS.map((b, i) => (
            <div
              key={b.from}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-3 last:border-b"
            >
              <span
                aria-hidden
                className="font-display text-[15px] leading-none text-ink-faint"
              >
                0{i + 1}
              </span>
              <dt className="text-[13.5px] leading-[1.5] text-ink-faint">
                {b.from}
              </dt>
              <span aria-hidden className="text-[13px] text-ink-faint">
                →
              </span>
              <dd className="text-[13.5px] font-medium leading-[1.5] text-ink-soft">
                {b.to}
              </dd>
            </div>
          ))}
        </dl>

        {/* ── mobile plate: stacked, no bleed ────────────────────── */}
        <div className="relative z-10 mt-12 md:hidden">
          <ThemedImage
            night="/tree-night.png"
            day="/tree-day.png"
            alt="A glowing amber zero at the base of a tree, its lit leaves spreading into a full canopy."
            width={1254}
            height={1254}
            sizes="74vw"
            className="plate-feather mx-auto h-auto w-full max-w-[300px]"
          />
        </div>
      </section>
    </>
  );
}
