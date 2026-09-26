import { KIND_LABELS, type ChallengeKind, type CoverTheme } from "@/lib/challenges-shared";

/**
 * A challenge's square cover. An uploaded image when there is one; otherwise a
 * typographic poster built from the title — the same system as the OG image
 * (DESIGN.md: typography, one yellow, no stock art), so an admin who never
 * uploads anything still gets a page that looks designed.
 *
 * Server-safe (no hooks), so the index and event pages render it statically.
 */
export function ChallengeCover({
  title,
  kind,
  imageUrl,
  theme,
  footer,
  size = "lg",
  className = "",
}: {
  title: string;
  kind: ChallengeKind;
  imageUrl: string | null;
  theme: CoverTheme;
  /** Bottom line on the typographic cover — usually the prize headline. */
  footer?: string;
  size?: "lg" | "sm";
  className?: string;
}) {
  const base = `relative aspect-square w-full overflow-hidden rounded-xl border border-line ${className}`;

  if (imageUrl) {
    return (
      <div className={`${base} bg-wash`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL, arbitrary aspect; next/image would need a remotePatterns entry per project */}
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full object-cover"
          loading={size === "lg" ? "eager" : "lazy"}
        />
      </div>
    );
  }

  const palette =
    theme === "ink"
      ? "bg-[#141414] text-[#FFBB00]"
      : theme === "paper"
        ? "bg-paper text-ink"
        : "bg-phosphor text-on-phosphor";
  const rule =
    theme === "ink"
      ? "border-[#FFBB00]/40"
      : theme === "paper"
        ? "border-phosphor"
        : "border-on-phosphor/30";

  if (size === "sm") {
    return (
      <div className={`${base} ${palette} flex flex-col justify-between p-2.5`}>
        <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.16em] opacity-80">
          {KIND_LABELS[kind]}
        </span>
        <span className="line-clamp-3 font-display text-[15px] leading-[1.05]">
          {title}
        </span>
      </div>
    );
  }

  const len = title.length;
  const titleSize =
    len <= 18
      ? "text-[clamp(2.5rem,7vw,3.75rem)]"
      : len <= 36
        ? "text-[clamp(2rem,5.5vw,3rem)]"
        : "text-[clamp(1.6rem,4.2vw,2.35rem)]";

  return (
    <div className={`${base} ${palette} flex flex-col justify-between p-6 sm:p-7`}>
      <div className="flex items-center justify-between font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">
        <span>batch0</span>
        <span className="opacity-80">{KIND_LABELS[kind]}</span>
      </div>
      <p className={`font-display ${titleSize} leading-[0.98] [overflow-wrap:anywhere]`}>
        {title}
      </p>
      <div className={`border-t-2 border-dotted ${rule} pt-3 font-mono text-[12px] font-medium`}>
        {footer || "Build something. Ship it."}
      </div>
    </div>
  );
}
