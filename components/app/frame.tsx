import Link from "next/link";
import { TabBar, type Tab } from "./tab-bar";

/**
 * The chrome every screen in the installed app sits inside.
 *
 * Sizing here is phone-first and deliberately roomy. The first pass was built
 * to fit as much as possible above the fold and read as cramped on a real
 * device: 54px rows, 13px secondary text, 12px gutters. Touch UI wants the
 * opposite of density — a 62px row with air around it is easier to hit AND
 * easier to scan, and scrolling is free.
 *
 * Two measurements are load-bearing rather than cosmetic:
 *
 *   `pb-[calc(3.75rem+var(--safe-bottom)+1.5rem)]` on <main> — the tab bar is
 *   `fixed`, so it takes no layout space. 3.75rem is its height, the inset is
 *   the home indicator, and the rest stops the last row of a list from sitting
 *   under the bar. Change the bar's height and this must move with it.
 *
 *   `min-h-[100dvh]`, not `100vh` — on iOS Safari `vh` is the *largest*
 *   viewport height, so a full-height screen is always taller than what you can
 *   see and the page scrolls a little for no reason.
 *
 * The header is NOT part of this component even though it looks like it
 * belongs. A Next layout cannot know its child page's title, and threading one
 * through would mean either a context provider (a client boundary around the
 * whole app, to render a string) or a `usePathname` lookup table that goes
 * stale the day someone adds a route. A page rendering its own <AppHeader> is
 * one line and cannot drift. It still sticks to the viewport from inside
 * <main>, since <main> is not a scroll container.
 */
export function AppShell({
  tabs,
  children,
}: {
  tabs: Tab[];
  children: React.ReactNode;
}) {
  return (
    // No overflow-x here on purpose. <body> already carries `overflow-x: clip`
    // globally (app/globals.css), and that file documents why it must be `clip`
    // and not `hidden`: `hidden` on one axis forces the other to `auto`, which
    // makes the element a scroll container and silently stops every
    // `position: sticky` descendant from sticking. AppHeader is sticky, so
    // re-declaring overflow here is at best redundant and at worst the exact
    // bug that comment exists to prevent.
    <div className="min-h-[100dvh] bg-paper text-ink">
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto min-h-[100dvh] max-w-[32rem] pb-[calc(3.75rem+var(--safe-bottom)+1.5rem)] sm:border-x sm:border-line"
      >
        {children}
      </main>
      <TabBar tabs={tabs} />
    </div>
  );
}

/**
 * The per-screen header.
 *
 * The top padding is `max(1rem, env(safe-area-inset-top))`, not the bare inset.
 * That is the fix for the title rendering under the status bar: the inset
 * resolves to 0 in plenty of real contexts — a normal browser tab, Android, a
 * desktop window, any viewport where `viewport-fit: cover` didn't take — and a
 * header padded only by the inset then has no padding at all and collides with
 * whatever the OS draws on top. max() means the header always has real
 * breathing room and grows to clear a notch when there is one.
 */
export function AppHeader({
  title,
  eyebrow,
  action,
}: {
  title: string;
  /** Small uppercase line above the title — cohort name, week, role. */
  eyebrow?: string;
  /** Optional control on the right of the header. */
  action?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/90 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-xl">
      <div className="flex items-center gap-3 px-5 pb-4 sm:px-6">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
              {eyebrow}
            </p>
          )}
          <h2 className="mt-1 truncate font-display text-[1.75rem] leading-none tracking-[-0.01em] text-ink">
            {title}
          </h2>
        </div>
        {action}
      </div>
    </header>
  );
}

/** The padded body under the header. Every screen wraps its content in this. */
export function AppBody({ children }: { children: React.ReactNode }) {
  return <div className="px-5 pt-7 sm:px-6">{children}</div>;
}

/** Section heading. Uppercase mono label, matching the panels. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
          {title}
        </h3>
        {action && (
          <Link
            href={action.href}
            className="press -my-1 shrink-0 py-1 text-[13px] text-phosphor-ink hover:underline"
          >
            {action.label} →
          </Link>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** The empty state. One sentence, no illustration, no call to action it can't honour. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-[14px] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}

/**
 * A big number with a label. Tapping it goes somewhere when there is somewhere
 * to go — a count with no destination stays a plain div rather than a link that
 * does nothing, which on a touch screen is indistinguishable from a broken one.
 */
export function Stat({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "default" | "accent" | "warn";
}) {
  const valueTone =
    tone === "accent"
      ? "text-phosphor-ink"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-300"
        : "text-ink";
  const body = (
    <>
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </p>
      {/* Fixed-width digits: these sit in a grid, and proportional numerals
          make two tiles side by side look misaligned as the counts change. */}
      <p
        className={`mt-2.5 text-[2.125rem] font-semibold leading-[0.95] tracking-[-0.02em] tabular-nums ${valueTone}`}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">{hint}</p>
      )}
    </>
  );
  const cls =
    "rounded-2xl border border-line bg-wash px-4 py-4 min-h-[7rem] flex flex-col justify-center";
  if (!href) return <div className={cls}>{body}</div>;
  return (
    <Link
      href={href}
      className={`press hover:border-ink/25 active:scale-[0.985] ${cls}`}
    >
      {body}
    </Link>
  );
}

/**
 * A list row — the single definition of what a row in this app measures.
 *
 * That "single" is the point. Three screens (People, Events, Course) used to
 * hand-roll this markup because Row couldn't express what they needed: a
 * leading icon, or an external link. So they each froze a copy of the metrics
 * at the moment they were written, and when the app's spacing was reworked
 * they silently kept the old cramped numbers — People was still 58px tall with
 * 15px text while every shared Row had moved to 62px and 15.5px. A primitive
 * that can't cover its real call sites doesn't get used, and then it isn't a
 * primitive. `leading`, `external` and `prefetch` exist to close exactly those
 * three gaps.
 *
 * `href` makes the whole row the tap target rather than the label inside it —
 * on a phone, a 300px-wide row with a 60px hit area is the single most common
 * reason a screen feels broken.
 */
export function Row({
  label,
  value,
  meta,
  href,
  external,
  prefetch,
  leading,
  right,
  muted,
}: {
  label: string;
  /** Secondary line, in body type. */
  value?: React.ReactNode;
  /**
   * Tertiary line, in mono — ids, emails, timestamps.
   *
   * ReactNode, not string: half the timestamps in this app render through
   * <LocalTime>, which has to be a component (the server has no idea what
   * timezone the reader is in). Typing these slots as `string` is what pushed
   * the Events list into hand-rolling its own row in the first place.
   */
  meta?: React.ReactNode;
  href?: string;
  /** Render an <a target="_blank"> instead of a <Link>. For off-site URLs. */
  external?: boolean;
  /** Pass false for links to routes with no loading boundary — prefetching a
   *  dynamic route under staleTimes.dynamic=0 is a render thrown away, and a
   *  long list would pay it once per visible row. */
  prefetch?: boolean;
  /** Icon slot before the text — completion state, status. */
  leading?: React.ReactNode;
  right?: React.ReactNode;
  muted?: boolean;
}) {
  const body = (
    <div className="flex min-h-[3.875rem] items-center gap-3.5 py-3.5">
      {leading}
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[15.5px] leading-snug ${
            muted ? "text-ink-soft" : "text-ink"
          }`}
        >
          {label}
        </p>
        {value && (
          <p className="mt-1 truncate text-[13.5px] leading-snug text-ink-soft">
            {value}
          </p>
        )}
        {meta && (
          <p className="mt-1 truncate font-mono text-[11.5px] text-ink-faint">
            {meta}
          </p>
        )}
      </div>
      {right}
    </div>
  );
  if (!href) return <div className="border-b border-line last:border-0">{body}</div>;

  // The negative margin lets the pressed state bleed past the list's padding to
  // the card edge, which is what makes a tap feel like it hit the row rather
  // than a box inside it.
  const cls =
    "press -mx-2 block rounded-lg border-b border-line px-2 last:border-0 active:bg-wash";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {body}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={prefetch} className={cls}>
      {body}
    </Link>
  );
}

/** Attention band — a fee due, a blocked student, funds wired. */
export function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: "warn" | "good" | "info";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const tones = {
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    info: "border-phosphor/30 bg-phosphor/[0.06] text-phosphor-ink",
  } as const;
  return (
    <div className={`rounded-2xl border px-5 py-4 ${tones[tone]}`}>
      <p className="text-[14px] font-medium leading-snug">{title}</p>
      {children && (
        <div className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
          {children}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * The one primary action shape, so buttons across the app can't drift.
 * 44px tall is the floor for a comfortable touch target; these are 44 and 48.
 */
export function ActionLink({
  href,
  children,
  size = "md",
}: {
  href: string;
  children: React.ReactNode;
  size?: "sm" | "md";
}) {
  const h = size === "sm" ? "h-10 px-4 text-[13px]" : "h-12 px-5 text-[14px]";
  return (
    <Link
      href={href}
      className={`press inline-flex select-none items-center gap-2 rounded-xl bg-phosphor font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] ${h}`}
    >
      {children}
    </Link>
  );
}
