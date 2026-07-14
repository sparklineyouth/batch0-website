import { formatCents, type PublicWinner } from "@/lib/challenges";

/**
 * Public "recently funded" strip. Ledger-styled, PII-safe by construction —
 * it only ever receives the curated public_name / public_blurb / amount an
 * admin explicitly published. Renders nothing when there are no winners.
 */
export function ChallengeWinners({ winners }: { winners: PublicWinner[] }) {
  if (!winners.length) return null;
  return (
    <section className="px-5 py-24 sm:px-6 md:py-32">
      <div className="mx-auto max-w-[1100px]">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          Recently funded
        </p>
        <h2 className="mt-3 max-w-2xl font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.02em] text-ink">
          Students we backed to build their idea
        </h2>
        <ul className="mt-8 divide-y divide-line border-t border-line">
          {winners.map((w) => (
            <li
              key={w.id}
              className="flex items-baseline justify-between gap-4 py-4"
            >
              <div className="min-w-0">
                <span className="font-medium text-ink">
                  {w.publicName ?? "A student"}
                </span>
                {w.publicBlurb && (
                  <span className="text-ink-soft"> — {w.publicBlurb}</span>
                )}
                {w.publicProjectUrl && (
                  <a
                    href={w.publicProjectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 whitespace-nowrap text-xs text-phosphor-ink underline decoration-phosphor-ink/30 underline-offset-2 hover:decoration-phosphor-ink"
                  >
                    View →
                  </a>
                )}
              </div>
              {w.payoutAmountCents != null && (
                <span className="shrink-0 font-mono text-sm text-phosphor-ink">
                  {formatCents(w.payoutAmountCents)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
