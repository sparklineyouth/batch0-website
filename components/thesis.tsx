import React from "react";
import { Section, Eyebrow } from "@/components/section-kit";

/**
 * The thesis — ONE loud thing.
 *
 * The tree plate that used to anchor this section has been removed, so
 * the statement now runs on its own at full measure rather than sharing
 * a grid with an image. The escalation underneath is the section's
 * supporting structure; it is what keeps this from being text alone in
 * empty space now that the art is gone.
 *
 * The tracer is "company." — the word the argument lands on. It uses the
 * reactive phosphor token, not literal #FFBB00: on cream, flat amber is
 * far below AA as text.
 */

const BEATS: { from: string; to: string }[] = [
  { from: "an idea", to: "something someone will pay for" },
  { from: "a landing page", to: "a product with users on it" },
  { from: "a hunch", to: "a company with your name on the cap table" },
];

export default function Thesis() {
  return (
    <Section id="thesis">
      <div className="max-w-[46rem]">
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

      {/* ── the escalation ─────────────────────────────────────── */}
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
