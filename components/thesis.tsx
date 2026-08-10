import React from "react";
import { ThemedImage } from "@/components/themed-image";
import { ZeroThread } from "@/components/zero-thread";

/**
 * The thesis — the page's first argument, and the pattern every other
 * section below the hero follows.
 *
 * SHAPE: asymmetric two-column. The argument runs down a 6-column
 * measure on the left; the tree occupies its own 5-column plate on the
 * right, vertically centred against the whole block rather than pinned
 * to the headline. Below md they stack, argument first — the tree
 * illustrates the claim, so it should never arrive before it.
 *
 * THE TREE IS THEME-PAIRED. It was hardcoded to tree-night, which put a
 * black-backed square on cream in the paper theme. It is a ThemedImage
 * now, so the white-backed frame shows on paper and neither one carries
 * a visible edge against the page.
 *
 * The escalation is a real definition list: three rows, each raising the
 * stakes on the last, with the numerals in VT323 so the pixel texture
 * survives in the one place it still earns its keep.
 */

const BEATS: { from: string; to: string }[] = [
  { from: "an idea", to: "something someone will pay for" },
  { from: "a landing page", to: "a product with users on it" },
  { from: "a hunch", to: "a company with your name on the cap table" },
];

export default function Thesis() {
  return (
    <>
      {/* soft seam instead of a hard full-width rule */}
      <hr className="sec-seam" />
      <section id="thesis" className="sec font-body">
      <div className="grid grid-cols-12 items-center gap-x-6 gap-y-12 md:gap-y-0">
        {/* ── the argument ─────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-6 lg:col-span-6">
          <p className="sec-eyebrow">the thesis</p>

          <h2 className="sec-h2 mt-4 max-w-[15ch]">
            come in with an idea. leave with a company.
          </h2>

          <p className="sec-lead mt-5 max-w-[46ch]">
            Nine weeks is short on purpose — long enough to build the thing,
            short enough that you cannot spend it planning.
          </p>

          {/* the escalation */}
          <dl className="mt-9">
            {BEATS.map((b, i) => (
              <div
                key={b.from}
                className="grid grid-cols-[2.75rem_1fr] items-baseline gap-x-2 border-t border-line py-4 last:border-b"
              >
                <span
                  aria-hidden
                  className="font-display text-[19px] leading-none text-ink-faint"
                >
                  0{i + 1}
                </span>
                <div>
                  <dt className="sec-body text-ink-faint">{b.from}</dt>
                  <dd className="mt-0.5 text-[16.5px] font-medium leading-[1.45] text-ink">
                    {b.to}
                  </dd>
                </div>
              </div>
            ))}
          </dl>

          <p className="sec-body mt-7 max-w-[48ch]">
            You start at <ZeroThread>zero</ZeroThread> either way. The
            difference is what you are standing on nine weeks later.
          </p>
        </div>

        {/* ── the plate ────────────────────────────────────────────── */}
        <div className="col-span-12 md:col-span-5 md:col-start-8">
          <ThemedImage
            night="/tree-night.png"
            day="/tree-day.png"
            alt="A glowing amber zero at the base of a tree, its lit leaves spreading into a full canopy."
            width={1254}
            height={1254}
            sizes="(max-width: 768px) 74vw, 440px"
            className="plate-feather mx-auto h-auto w-full max-w-[320px] md:max-w-[440px]"
          />
        </div>
      </div>
      </section>
    </>
  );
}
