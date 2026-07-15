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
 * The front page — the homepage's information workhorse, set like a
 * broadsheet: masthead rule, glyph-led story columns, the aug 10 deadline
 * as the lead story. One job: the whole factual deal (dates, price with
 * the no-hidden-fees ledger, deliverables manifest). Its one action is the
 * refund-policy link; per the one-ask rule there is no apply CTA here.
 *
 * This is the page's second LOUD moment (poster #2 of 3). Every value
 * renders from site-config.
 */

const ARTIFACTS: { file: string; note: string }[] = [
  { file: "lean-canvas.pdf", note: "Tested in interviews with strangers who owe you nothing." },
  { file: "shipped-v1.url", note: "Landing page, no-code MVP, or working prototype. Live and ready for the world to see." },
  { file: "business-model.xlsx", note: "Revenue, pricing, and unit economics you can defend on demo day." },
  { file: "go-to-market.md", note: "A concrete path to your first paying customers, completeing with a funnel and marketing plan." },
  { file: "pitch-deck.key", note: "Written, rehearsed, and delivered live at demo day." },
  { file: "your-company/", note: "batch0 takes no equity, no IP, and no royalties. Everything you build is yours." },
];

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
    <section
      id="front-page"
      className="border-t border-phosphor/25 px-5 py-20 sm:px-6 md:py-32"
    >
      <div className="mx-auto max-w-[1100px]">
        <p className="cmdline font-mono">
          <b>cat front-page.txt</b>{" "}
          <span className="mtime">· modified 2026-07-14</span>
        </p>

        {/* masthead */}
        <div className="mt-5 flex flex-wrap items-baseline justify-between gap-3 border-b border-phosphor pb-2.5">
          <span className="font-display text-[clamp(2.375rem,5vw,4rem)] leading-[0.9] text-ink">
            batch<b className="font-normal text-phosphor">0</b>
          </span>
          <span className="font-mono text-xs tracking-[0.05em] text-phosphor/60">
            vol. {cohortCode} · {derived.cohortName.toLowerCase()} · live,
            online · us
          </span>
        </div>

        {/* story columns, row 1: the lead is the deadline */}
        <div className="grid md:grid-cols-[2fr_1fr_1fr]">
          <article className="border-b border-line py-6 md:border-b-0 md:border-r md:pr-6">
            <FlagIcon size={7} />
            <h3 className="mt-4 max-w-[14ch] font-display text-[clamp(2rem,4.4vw,3.75rem)] leading-[0.95] text-ink">
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
            <p className="mt-3 max-w-[42ch] text-[13.5px] leading-[1.6] text-ink-soft">
              reviewed on a rolling basis, read by the founders.{" "}
              <b className="font-semibold text-ink">$0 to apply.</b>
            </p>
          </article>

          <article className="border-b border-line py-6 md:border-b-0 md:border-r md:px-6">
            <CalendarIcon size={5} />
            <h3 className="mt-4 font-display text-[clamp(1.625rem,2.6vw,2.25rem)] leading-[0.95] text-ink">
              {dates || "dates tba"}
            </h3>
            <p className="mt-3 max-w-[38ch] text-[13.5px] leading-[1.6] text-ink-soft">
              live build sprints, mentorship, and a demo day, all online.
              designed to fit around school.
            </p>
          </article>

          <article className="py-6 md:pl-6">
            <ReceiptIcon size={5} />
            <h3 className="mt-4 font-display text-[clamp(1.625rem,2.6vw,2.25rem)] leading-[0.95] text-ink">
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
            <p className="mt-3 text-[12.5px] text-ink-faint">
              <Link href="/refund-policy" className="link-ink">
                see refund policy
              </Link>
              {derived.isRegionalPrice
                ? " · showing adjusted pricing for your region"
                : ""}
            </p>
          </article>
        </div>

        {/* row 2: the deliverables manifest */}
        <div className="border-t border-line pt-6">
          <div className="flex items-center gap-4">
            <FolderIcon size={4} />
            <h3 className="font-display text-[clamp(1.375rem,2.2vw,1.75rem)] leading-none text-ink">
              what you leave with
            </h3>
            <span className="font-mono text-[13px] text-phosphor/60">
              · total 6 · by demo day
            </span>
          </div>
          <ul className="mt-4 grid gap-x-10 md:grid-cols-2">
            {ARTIFACTS.map((a) => (
              <li
                key={a.file}
                className="grid grid-cols-[21ch_1fr] gap-x-4 border-t border-line py-2.5 max-sm:grid-cols-1"
              >
                <span className="font-mono text-[13.5px] font-semibold text-ink">
                  {a.file}
                </span>
                <span className="text-[13px] leading-[1.55] text-ink-soft">
                  {a.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
