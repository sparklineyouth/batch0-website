import React from "react";
import { Section, Eyebrow, Fig } from "@/components/section-kit";
import { ManifestAnchor } from "@/components/anchors";

/**
 * What you leave with — deliberately a DIFFERENT shape from the program
 * above it: that section is a vertical run of numbered steps, so this
 * one is a two-column grid of artefacts. No two adjacent sections share
 * a silhouette.
 */

const ARTIFACTS: { file: string; note: string }[] = [
  { file: "lean-canvas.pdf", note: "Tested in interviews with strangers who owe you nothing." },
  { file: "shipped-v1.url", note: "Landing page, no-code MVP, or working prototype. Live and ready for the world to see." },
  { file: "business-model.xlsx", note: "Revenue, pricing, and unit economics you can defend on demo day." },
  { file: "go-to-market.md", note: "A concrete path to your first paying customers, complete with a funnel and marketing plan." },
  { file: "pitch-deck.key", note: "Written, rehearsed, and delivered live at demo day." },
  { file: "your-company/", note: "batch0 takes no equity, no IP, and no royalties. Everything you build is yours." },
];

export default function Manifest() {
  return (
    <Section id="what-you-leave-with">
      <div className="grid grid-cols-12 items-start gap-x-6 gap-y-14">
        <div className="col-span-12 md:col-span-7">
          <Eyebrow>what you leave with</Eyebrow>
          <h2 className="sec-display mt-6 max-w-[13ch]">
            six things, and the last one is{" "}
            <span className="text-phosphor">yours.</span>
          </h2>
          <p className="sec-lead mt-8 max-w-[44ch]">
            Not a certificate. The actual artefacts of a company, and the
            company itself.
          </p>
        </div>

        <div className="col-span-12 md:col-span-4 md:col-start-9">
          <div className="mx-auto max-w-[20rem] md:mx-0">
            <ManifestAnchor />
            <Fig n="02" className="mt-5">
              the manifest
            </Fig>
          </div>
        </div>
      </div>

      <ul className="mt-16 grid grid-cols-12 gap-x-6">
        {ARTIFACTS.map((a, i) => (
          <li
            key={a.file}
            className={`col-span-12 border-t border-line py-5 md:col-span-6 ${
              i >= ARTIFACTS.length - 2 ? "md:border-b" : ""
            } ${i === ARTIFACTS.length - 1 ? "border-b" : ""}`}
          >
            <p
              className={`font-mono text-[14px] font-medium ${
                i === ARTIFACTS.length - 1 ? "text-phosphor" : "text-ink"
              }`}
            >
              {a.file}
            </p>
            <p className="sec-body mt-1.5 max-w-[46ch]">{a.note}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
