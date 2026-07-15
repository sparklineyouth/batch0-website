import React from "react";

/**
 * THE ZERO THREAD — the sitewide rule that every MEANINGFUL zero renders
 * in amber: the 0 in batch0, 0% equity, $0 to apply, the 00 in cohort 001.
 * The zeroes are the pitch, and the amber teaches the eye that.
 *
 * Wrap only strings whose zeroes carry the deal. Zeroes that are just
 * digits (timestamps, step numbers, $130, years) must NOT be wrapped —
 * they stay off-white with the rest of the numerals.
 *
 *   <ZeroThread>0% equity</ZeroThread>
 *   <ZeroThread>$0 to apply</ZeroThread>
 *   cohort <ZeroThread>001</ZeroThread>
 */
export function ZeroThread({
  children,
  className = "",
}: {
  /** The string whose zeroes are meaningful. */
  children: string;
  className?: string;
}) {
  const parts = children.split(/(0+)/);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        /^0+$/.test(p) ? (
          <span key={i} className="text-phosphor">
            {p}
          </span>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </span>
  );
}
