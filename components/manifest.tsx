import React from "react";
import { FolderIcon } from "@/components/icons/pixel-icon";

/**
 * What you leave with — the deliverables manifest, read as an `ls -la` of
 * the directory you walk away owning. Lifted verbatim from the old
 * front-page.tsx. No action: this section only has to be true.
 */

const ARTIFACTS: { file: string; note: string }[] = [
  { file: "lean-canvas.pdf", note: "Tested in interviews with strangers who owe you nothing." },
  { file: "shipped-v1.url", note: "Landing page, no-code MVP, or working prototype. Live and ready for the world to see." },
  { file: "business-model.xlsx", note: "Revenue, pricing, and unit economics you can defend on demo day." },
  { file: "go-to-market.md", note: "A concrete path to your first paying customers, complete with a funnel and marketing plan." },
  { file: "pitch-deck.key", note: "Written, rehearsed, and delivered live at demo day." },
  { file: "your-company/", note: "batch0 takes no equity, no IP, and no royalties. Everything you build is yours." },
];

const ICON_SIZE = 5;

export default function Manifest() {
  return (
    <section id="what-you-leave-with" className="border-t border-line py-14 md:py-20">
      <p className="section-intro">the six things you own at the end.</p>

      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FolderIcon size={ICON_SIZE} />
          <h2 className="t-body font-semibold text-ink">what you leave with</h2>
        </div>
        <ul className="mt-4 grid grid-cols-12 gap-x-6">
          {ARTIFACTS.map((a) => (
            <li key={a.file} className="col-span-12 md:col-span-6">
              <div className="grid grid-cols-12 gap-x-6 border-t border-line py-2.5 max-sm:grid-cols-1">
                <span className="t-small col-span-5 font-mono font-semibold text-ink">
                  {a.file}
                </span>
                <span className="t-small col-span-7 text-ink-soft">
                  {a.note}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
