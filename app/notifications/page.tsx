import Link from "next/link";
import { ArrowLeft, Bell, SlidersHorizontal } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile, roleHome } from "@/lib/auth";
import {
  isImportanceValue,
  kindFor,
  splitByImportance,
  type ImportanceOverrides,
} from "@/lib/notification-importance";
import { MarkAllRead } from "./mark-all-read";
import { NotificationItem } from "./notification-item";
import { ImportanceSettings } from "./importance-settings";

export const metadata = { title: "Notifications · batch0" };

type Tab = "important" | "other" | "settings";

function tabFrom(raw: string | undefined): Tab {
  if (raw === "other" || raw === "settings") return raw;
  return "important";
}

export default async function NotificationsPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  const tab = tabFrom(searchParams.tab);
  const user = await requireUser();
  const supabase = await createClient();

  // The list needs only the user id, so it loads alongside the back-link's
  // home resolution (profile → role home) instead of behind it. The overrides
  // are a third small read on the same trip.
  const [home, { data: items }, { data: prefRows }] = await Promise.all([
    getProfile().then((p) => roleHome(p?.role ?? "student")),
    supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("notification_importance")
      .select("type, importance")
      .eq("user_id", user.id),
  ]);

  // Only the types this person has reclassified; everything else falls through
  // to the shipped default in lib/notification-importance.ts. A failed read
  // (nothing selected, table absent) degrades to "everyone's defaults" rather
  // than to an error page.
  const overrides: ImportanceOverrides = {};
  for (const r of (prefRows ?? []) as { type: string; importance: string }[]) {
    if (isImportanceValue(r.importance)) overrides[r.type] = r.importance;
  }

  const all = items ?? [];
  const { important, other } = splitByImportance(all, overrides);
  const shown = tab === "other" ? other : important;
  const unread = shown.filter((i) => !i.read_at);
  const read = shown.filter((i) => i.read_at);
  // Scopes "Mark all read" to the tab you're looking at.
  const shownTypes = Array.from(new Set(shown.map((i) => i.type)));

  // Types this person has actually received that the catalog doesn't name — a
  // feature newer than the list — so the settings tab can still offer to
  // reclassify them instead of pretending they don't exist.
  const extraTypes = Array.from(
    new Set(all.map((i) => i.type).filter((t) => !kindFor(t))),
  ).sort();

  const TABS: { key: Tab; label: string; count?: number }[] = [
    {
      key: "important",
      label: "Important",
      count: important.filter((i) => !i.read_at).length,
    },
    {
      key: "other",
      label: "Everything else",
      count: other.filter((i) => !i.read_at).length,
    },
    { key: "settings", label: "What counts as important" },
  ];

  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <Link
            href={home}
            className="press inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          {tab !== "settings" && unread.length > 0 && (
            <MarkAllRead types={shownTypes} />
          )}
        </div>
      </div>

      <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-5 py-10 md:px-8 md:py-14">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
              Inbox
            </p>
            <h1 className="mt-2 font-display text-3xl md:text-4xl font-bold tracking-[-0.02em] text-ink">
              Notifications
            </h1>
          </div>
          {tab !== "settings" && (
            <p className="shrink-0 text-sm text-ink-soft">
              {unread.length > 0 ? `${unread.length} unread` : "All caught up"}
            </p>
          )}
        </div>

        <nav
          aria-label="Notification views"
          className="mt-8 flex flex-wrap gap-1 border-b border-line pb-px"
        >
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={
                  t.key === "important"
                    ? "/notifications"
                    : `/notifications?tab=${t.key}`
                }
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "border-phosphor text-ink"
                    : "border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {t.key === "settings" && (
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                )}
                {t.label}
                {t.count ? (
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums ${
                      active
                        ? "bg-phosphor text-on-phosphor"
                        : "bg-wash text-ink-soft"
                    }`}
                  >
                    {t.count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {tab === "settings" ? (
          <div className="mt-8">
            <ImportanceSettings overrides={overrides} extraTypes={extraTypes} />
          </div>
        ) : shown.length === 0 ? (
          <div className="mt-12 rounded-2xl border border-line bg-wash px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-line">
              <Bell className="h-4 w-4 text-ink-faint" />
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              {all.length === 0
                ? "No notifications yet."
                : tab === "other"
                  ? "Nothing over here."
                  : "Nothing important right now."}
            </p>
            {all.length > 0 && tab !== "other" && (
              <p className="mt-1 text-xs text-ink-faint">
                The rest is under{" "}
                <Link
                  href="/notifications?tab=other"
                  className="underline hover:text-ink-soft"
                >
                  Everything else
                </Link>
                .
              </p>
            )}
          </div>
        ) : (
          <div className="mt-10 space-y-10">
            {unread.length > 0 && (
              <section>
                <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                  Unread
                </h2>
                <ul className="divide-y divide-line border-y border-line">
                  {unread.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
            {read.length > 0 && (
              <section>
                <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                  Earlier
                </h2>
                <ul className="divide-y divide-line border-y border-line">
                  {read.map((n) => (
                    <NotificationItem key={n.id} n={n as any} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
