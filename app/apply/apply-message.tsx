import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/wordmark";

/**
 * The /apply shell for the moments there's nothing to fill in — applications
 * closed, or no cohort open to this applicant. Same header and type as the
 * question flow (app/apply/apply-flow.tsx), so arriving here reads as the
 * same place with a different answer rather than a different site.
 */
export function ApplyMessage({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-[100dvh] flex-col bg-paper outline-none">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="batch0 home">
            <Wordmark className="h-4 text-ink" />
          </Link>
          <Link href="/dashboard" className="text-sm text-ink-soft hover:text-ink">
            Dashboard
          </Link>
        </div>
      </header>
      <div className="flex flex-1 items-start sm:items-center">
        <section className="mx-auto w-full max-w-2xl px-5 py-16 sm:px-8">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-phosphor-ink">{eyebrow}</p>
          <h1 className="mt-4 font-display text-[clamp(2.5rem,7vw,3.75rem)] leading-[1.04] text-ink">{title}</h1>
          <div className="mt-5 max-w-xl space-y-3 text-base leading-relaxed text-ink-soft">{children}</div>
          {actions && <div className="mt-8 flex flex-wrap items-center gap-4">{actions}</div>}
        </section>
      </div>
    </main>
  );
}
