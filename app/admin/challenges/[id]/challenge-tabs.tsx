"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function ChallengeTabs({
  id,
  counts,
}: {
  id: string;
  counts: { registrations: number; submissions: number; drafts: number };
}) {
  const path = usePathname() ?? "";
  const base = `/admin/challenges/${id}`;
  const tabs = [
    { href: `${base}/edit`, label: "Edit", count: null as number | null },
    { href: `${base}/submissions`, label: "Submissions", count: counts.submissions },
    { href: `${base}/registrations`, label: "Registrations", count: counts.registrations },
  ];
  return (
    <nav className="mt-5 flex gap-1 border-b border-line" aria-label="Challenge sections">
      {tabs.map((t) => {
        const active = path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              active ? "border-phosphor font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className="rounded-full bg-wash px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">{t.count}</span>
            )}
          </Link>
        );
      })}
      {counts.drafts > 0 && (
        <span className="ml-auto self-center font-mono text-[11px] text-ink-faint">
          {counts.drafts} draft{counts.drafts === 1 ? "" : "s"} in progress
        </span>
      )}
    </nav>
  );
}
