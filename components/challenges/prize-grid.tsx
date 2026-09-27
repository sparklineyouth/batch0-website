import { Trophy, Gift, Sparkles } from "lucide-react";
import {
  formatCents,
  prizeTitle,
  type ChallengePrize,
} from "@/lib/challenges-shared";

const KIND_ICON = { cash: Trophy, item: Gift, perk: Sparkles } as const;

/**
 * The prize list. Object prizes (the Meta glasses) get their photo; cash and
 * perks get an icon tile. Server-safe.
 */
export function PrizeGrid({ prizes }: { prizes: ChallengePrize[] }) {
  if (prizes.length === 0) return null;
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {prizes.map((p) => {
        const Icon = KIND_ICON[p.kind];
        const title = prizeTitle(p);
        const showValue =
          p.valueCents != null && !(p.kind === "cash" && !p.title);
        return (
          <li
            key={p.id}
            className="flex gap-4 rounded-xl border border-line bg-paper p-3"
          >
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-wash">
              {p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img
                  src={p.imageUrl}
                  alt={title}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div
                  className={`flex h-full w-full items-center justify-center ${
                    p.kind === "cash" ? "bg-phosphor text-on-phosphor" : "text-phosphor-ink"
                  }`}
                >
                  {p.kind === "cash" && p.valueCents != null && !p.title ? (
                    <span className="font-display text-2xl">
                      {formatCents(p.valueCents)}
                    </span>
                  ) : (
                    <Icon className="h-7 w-7" aria-hidden />
                  )}
                </div>
              )}
            </div>
            <div className="min-w-0 py-0.5">
              {p.place && (
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-phosphor-ink">
                  {p.place}
                </p>
              )}
              <p className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">
                {title}
              </p>
              {p.description && (
                <p className="mt-1 line-clamp-3 text-[13px] leading-snug text-ink-soft">
                  {p.description}
                </p>
              )}
              <p className="mt-1 font-mono text-[12px] text-ink-faint">
                {[
                  showValue
                    ? p.kind === "cash"
                      ? formatCents(p.valueCents)
                      : `${formatCents(p.valueCents)} value`
                    : null,
                  p.quantity > 1 ? `${p.quantity} winners` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
