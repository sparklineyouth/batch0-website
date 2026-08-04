import React from "react";
import Link from "next/link";
import type { SiteConfig } from "@/lib/site-config";
import { CalendarIcon, ReceiptIcon, FlagIcon } from "@/components/icons/pixel-icon";
import { ZeroThread } from "@/components/zero-thread";

/**
 * The deal — the whole factual offer in one thin strip: deadline as the
 * lead story, dates, and the price ledger. Sits directly after the thesis
 * because the thesis provokes exactly one question ("what's the catch?")
 * and this answers it before the program detail arrives.
 *
 * Lifted verbatim from the old front-page.tsx story columns. One action:
 * the refund-policy link. Every icon leads the fact it means, at one size.
 */

const ICON_SIZE = 5; // one consistent icon size for this context

export default function TheDeal({ config }: { config: SiteConfig }) {
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
    <section id="the-deal" className="border-t border-line py-14 md:py-20">
      <p className="cmdline font-mono">
        <b>cat terms.txt</b>{" "}
        <span className="mtime">· modified 2026-07-14</span>
      </p>
      <p className="cmd-sub">dates, deadline, and what it costs.</p>

      {/* story columns on the shared grid; the lead is the deadline */}
      <div className="mt-6 grid grid-cols-12 gap-x-6">
        <article className="col-span-12 border-t border-line py-6 md:col-span-6 md:border-t-0 md:py-0">
          <FlagIcon size={ICON_SIZE} />
          <h3 className="t-head mt-4 max-w-[16ch] text-ink">
            {settings.applicationsOpen && closeLabel ? (
              <>
                applications for cohort <ZeroThread>{cohortCode}</ZeroThread>{" "}
                close <span data-retype>{closeLabel}</span>
              </>
            ) : settings.applicationsOpen ? (
              <>
                applications for cohort <ZeroThread>{cohortCode}</ZeroThread>{" "}
                are open
              </>
            ) : (
              <>applications are closed for now</>
            )}
          </h3>
          <p className="t-small mt-3 max-w-[42ch] text-ink-soft">
            reviewed on a rolling basis, read by the founders.
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
                <dt className="tracking-[0.06em] text-ink-faint">{k}</dt>
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
    </section>
  );
}
