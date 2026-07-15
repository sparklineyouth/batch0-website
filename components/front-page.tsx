import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";
import {
  CalendarIcon,
  ReceiptIcon,
  FlagIcon,
  FolderIcon,
} from "@/components/icons/pixel-icon";

/**
 * The front page — the homepage's DENSE movement and information workhorse.
 * One job: the whole factual deal (deadline as the lead story, dates,
 * price + no-hidden-fees ledger, deliverables manifest). One action: the
 * refund-policy link.
 *
 * Standard section anatomy (hairline + command head on the rail); the
 * story columns are columns OF the shared 12-column grid, and every icon
 * leads the fact it means at one size (5). All values from site-config.
 */

const ARTIFACTS: { file: string; note: string }[] = [
  { file: "lean-canvas.pdf", note: "Tested in interviews with strangers who owe you nothing." },
  { file: "shipped-v1.url", note: "Landing page, no-code MVP, or working prototype. Live and ready for the world to see." },
  { file: "business-model.xlsx", note: "Revenue, pricing, and unit economics you can defend on demo day." },
  { file: "go-to-market.md", note: "A concrete path to your first paying customers, completeing with a funnel and marketing plan." },
  { file: "pitch-deck.key", note: "Written, rehearsed, and delivered live at demo day." },
  { file: "your-company/", note: "batch0 takes no equity, no IP, and no royalties. Everything you build is yours." },
];

const ICON_SIZE = 5; // one consistent icon size for this context

export default function FrontPage({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const dates = derived.dateRangeLabel.replace("→", "–").toLowerCase();
  const cohortCode = config.cohort?.cohortNumber
    ? String(config.cohort.cohortNumber).padStart(3, "0")
    : "001";
  const closeLabel = config.cohort?.applicationsCloseAt
    ? new Date(config.cohort.applicationsCloseAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  return (
    <section id="front-page" className="border-t border-phosphor/25 py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat front-page.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>

      {/* story columns on the shared grid; the lead is the deadline */}
      <div className="mt-6 grid grid-cols-12 gap-x-6">
        <article className="col-span-12 border-t border-line py-6 md:col-span-6 md:border-t-0 md:py-0">
          <FlagIcon size={ICON_SIZE} />
          <h3 className="t-head mt-4 max-w-[16ch] text-ink">
            {settings.applicationsOpen && closeLabel ? (
              <>
                applications for cohort {cohortCode} close{" "}
                <span className="text-phosphor" data-retype>
                  {closeLabel}
                </span>
              </>
            ) : settings.applicationsOpen ? (
              <>applications for cohort {cohortCode} are open</>
            ) : (
              <>applications are closed for now</>
            )}
          </h3>
          <p className="t-small mt-3 max-w-[42ch] text-ink-soft">
            reviewed on a rolling basis, read by the founders.{" "}
            <b className="font-semibold text-ink">$0 to apply.</b>
          </p>
        </article>

        <article className="col-span-12 border-t border-line py-6 md:col-span-3 md:border-l md:border-t-0 md:py-0 md:pl-6">
          <CalendarIcon size={ICON_SIZE} />
          <h3 className="t-head mt-4 text-ink">{dates || "dates tba"}</h3>
          <p className="t-small mt-3 max-w-[38ch] text-ink-soft">
            live build sprints, mentorship, and a demo day, all online.
            designed to fit around school.
          </p>
        </article>

        <article className="col-span-12 border-t border-line py-6 md:col-span-3 md:border-l md:border-t-0 md:py-0 md:pl-6">
          <ReceiptIcon size={ICON_SIZE} />
          <h3 className="t-head mt-4 text-ink">
            {derived.priceLabel.toLowerCase()}, once
          </h3>
          <dl className="ledger mt-3 lowercase text-ink-soft">
            {[
              ["application", "free"],
              ["tuition", "only if accepted"],
              ["hidden fees", "none"],
              ["equity taken", "none"],
            ].map(([k, v]) => (
              <div key={k} className="ledger-row">
                <dt className="tracking-[0.06em] text-phosphor/60">{k}</dt>
                <span aria-hidden className="ledger-dots" />
                <dd className="text-right font-medium text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {/* this section's one action */}
          <p className="t-small mt-3 text-ink-faint">
            <Link href="/refund-policy" className="link-ink">
              see refund policy
            </Link>
            {derived.isRegionalPrice
              ? " · showing adjusted pricing for your region"
              : ""}
          </p>
        </article>
      </div>

      {/* the deliverables manifest */}
      <div className="mt-8 border-t border-line pt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FolderIcon size={ICON_SIZE} />
          <h3 className="t-body font-semibold text-ink">what you leave with</h3>
          <span className="t-small font-mono text-phosphor/60">
            · total 6 · by demo day
          </span>
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
