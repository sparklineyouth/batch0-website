import React from "react";
import Image from "next/image";
import { ZeroThread } from "@/components/zero-thread";

/**
 * The thesis — one short escalating beat: come in with an idea, leave
 * with a company. Three lines that each raise the stakes on the last,
 * beside the growth-tree plate.
 *
 * The tree is the ONLY place this motif appears on the site: an amber
 * zero at the root growing into a lit canopy. It illustrates, it does not
 * decorate — capped at 420px so it reads as a plate beside the argument
 * rather than competing with it, and it stacks under the text on mobile.
 */

const BEATS: { from: string; to: string }[] = [
  { from: "an idea", to: "something someone will pay for" },
  { from: "a landing page", to: "a product with users on it" },
  { from: "a hunch", to: "a company with your name on the cap table" },
];

export default function Thesis() {
  return (
    <section id="thesis" className="border-t border-line py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat thesis.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>
      <p className="cmd-sub">what nine weeks actually changes.</p>

      <div className="mt-6 grid grid-cols-12 items-center gap-x-6 gap-y-8">
        <div className="col-span-12 md:col-span-7">
          <h2 className="t-head max-w-[18ch] text-ink">
            come in with an idea. leave with a company.
          </h2>

          <dl className="mt-6">
            {BEATS.map((b, i) => (
              <div
                key={b.from}
                className="grid grid-cols-[6ch_1fr] border-t border-line py-3.5 last:border-b last:border-line"
              >
                <span aria-hidden className="t-small font-mono text-ink-faint">
                  0{i + 1}
                </span>
                <div className="t-body">
                  <dt className="inline text-ink-soft">{b.from}</dt>
                  <span aria-hidden className="mx-2 font-mono text-ink-faint">
                    →
                  </span>
                  <dd className="inline font-semibold text-ink">{b.to}</dd>
                </div>
              </div>
            ))}
          </dl>

          <p className="t-small mt-5 max-w-[52ch] text-ink-soft">
            nine weeks is short on purpose. it is long enough to build the
            thing and short enough that you cannot spend it planning. you
            start at <ZeroThread>zero</ZeroThread> either way.
          </p>
        </div>

        <div className="col-span-12 md:col-span-5">
          {/* Square source (1254²). Sized by max-width, height derived, so
              the plate scales down cleanly to a 390px viewport. */}
          <Image
            src="/growth-tree.png"
            alt="A glowing amber zero at the base of a tree, its lit leaves spreading into a full canopy."
            width={1254}
            height={1254}
            sizes="(max-width: 768px) 78vw, 420px"
            className="mx-auto h-auto w-full max-w-[300px] md:max-w-[420px]"
          />
        </div>
      </div>
    </section>
  );
}
