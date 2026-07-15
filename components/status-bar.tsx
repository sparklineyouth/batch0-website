"use client";
import { useEffect, useState } from "react";
import type { SiteConfig } from "@/lib/site-config";
import { ZeroThread } from "@/components/zero-thread";

/**
 * The live status bar — part of the brand identity, present on every
 * marketing page above the nav:
 *
 *   batch0 · cohort 001 · summer 2026 // aug 17 – oct 18 · live, online ·
 *   us // apply by aug 10 · t−28d · hh:mm:ss
 *
 * Every value renders from site-config; the t-minus and clock tick client
 * side (this is live DATA, not motion, so it ticks under reduced-motion
 * too). Server-rendered markup carries the static values so the bar is
 * complete without JS.
 */
export function StatusBar({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const closeAt = config.cohort?.applicationsCloseAt ?? null;

  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = now
    ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    : "--:--:--";
  const daysLeft =
    closeAt && now
      ? Math.max(0, Math.ceil((Date.parse(closeAt) - now.getTime()) / 864e5))
      : null;

  const cohortCode = config.cohort?.cohortNumber
    ? String(config.cohort.cohortNumber).padStart(3, "0")
    : "001";
  const dates = derived.dateRangeLabel.replace("→", "–").toLowerCase();
  const closeLabel = closeAt
    ? new Date(closeAt)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 overflow-hidden whitespace-nowrap border-b border-phosphor/25 px-5 py-1.5 font-mono text-xs tracking-[0.05em] text-phosphor/60 sm:px-6"
    >
      <span>
        <b className="font-medium text-phosphor">batch0</b> · cohort{" "}
        <ZeroThread className="font-medium text-ink">{cohortCode}</ZeroThread>
        <span className="hidden sm:inline">
          {" "}
          · {derived.cohortName.toLowerCase()}
        </span>
      </span>
      <span className="hidden md:inline">
        {dates || "dates tba"} · live, online · us
      </span>
      <span>
        {settings.applicationsOpen && closeLabel ? (
          <>
            apply by {closeLabel} ·{" "}
            <span className="text-ink">
              {daysLeft !== null ? `t−${daysLeft}d` : "t−·d"}
            </span>{" "}
            ·{" "}
          </>
        ) : null}
        <span suppressHydrationWarning>{clock}</span>
      </span>
    </div>
  );
}
