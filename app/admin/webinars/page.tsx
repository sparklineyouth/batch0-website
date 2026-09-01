import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dailyConfigured } from "@/lib/daily";
import { joinState, type LiveEvent } from "@/lib/live";
import { Card } from "@/components/ui/card";
import { WebinarsManager } from "./webinars-manager";
import { AlertTriangle } from "lucide-react";

export const metadata = { title: "Webinars · Admin" };

// Live status is time-sensitive; a cached page would show a webinar as
// upcoming after it had already started.
export const dynamic = "force-dynamic";

/**
 * Webinars, as their own thing.
 *
 * Under the hood a webinar is a row in `events` with `live_mode = 'hosted'`,
 * which is the right data model — it is an event, it belongs on the calendar,
 * and it reuses the visibility rules and the ICS export that events already
 * have. But it was only *reachable* as "create an event, then remember to flip
 * a toggle", which is not a feature anyone can find. This page is the surface:
 * schedule one in a form that already knows it is a webinar, then see the ones
 * you have.
 *
 * Everything else about an event — cohort, recording URL, Discord cross-post —
 * still lives in the full editor at /admin/events, and each row links there.
 */
export default async function AdminWebinarsPage() {
  await requirePermission("events.manage");
  const admin = createAdminClient();

  const [{ data: rows, error }, { data: cohorts }] = await Promise.all([
    admin
      .from("events")
      .select(
        "id, title, description, type, starts_at, ends_at, location, visibility, live_mode, daily_room_name, daily_room_url, recording_url",
      )
      .eq("live_mode", "hosted")
      .order("starts_at", { ascending: false })
      .limit(100),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  // `live_mode` arrives with migration 0058. Until it is applied the filter
  // above fails, and a 500 here would read as "webinars are broken" rather
  // than "one SQL file hasn't been run". Say which.
  const missingColumn =
    error &&
    (error.code === "42703" || /live_mode/.test(error.message ?? ""));

  if (missingColumn) {
    return (
      <Shell>
        <Card className="mt-6">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <h2 className="text-sm font-semibold text-ink">
                One migration still to run
              </h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                Webinars need the <code>live_mode</code> column on{" "}
                <code>events</code>. Paste{" "}
                <code className="text-phosphor-ink">
                  supabase/migrations/0058_hosted_events.sql
                </code>{" "}
                into the Supabase SQL Editor and run it — it&rsquo;s additive
                and safe to re-run. Then reload this page.
              </p>
              <p className="mt-2 text-xs text-ink-faint">
                Q&amp;A also needs <code>0060_webinar_questions.sql</code>.
              </p>
            </div>
          </div>
        </Card>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Couldn&rsquo;t load webinars: {error.message}
          </p>
        </Card>
      </Shell>
    );
  }

  const now = new Date();
  const webinars: (LiveEvent & { visibility: string })[] = (rows ?? []).map(
    (e: any) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      type: e.type,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      location: e.location,
      liveMode: "hosted",
      externalUrl: null,
      recordingUrl: e.recording_url,
      hostName: null,
      roomName: e.daily_room_name,
      roomUrl: e.daily_room_url,
      visibility: e.visibility,
    }),
  );

  // Grouped by what you'd actually do with them: one you can walk into now,
  // ones to prepare for, ones to pull a recording from.
  const live = webinars.filter(
    (w) => joinState(w.startsAt, w.endsAt, now) === "live",
  );
  const upcoming = webinars
    .filter((w) => ["early", "open"].includes(joinState(w.startsAt, w.endsAt, now)))
    .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
  const past = webinars.filter(
    (w) => joinState(w.startsAt, w.endsAt, now) === "ended",
  );

  return (
    <Shell>
      {!dailyConfigured() && (
        <Card className="mt-6">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Live video isn&rsquo;t configured here
              </h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                Set <code>DAILY_API_KEY</code> and{" "}
                <code>NEXT_PUBLIC_DAILY_DOMAIN</code> in this environment.
                Scheduling a webinar will fail until then.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <WebinarsManager
          live={live}
          upcoming={upcoming}
          past={past}
          cohorts={(cohorts ?? []) as { id: string; name: string }[]}
        />
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Webinars
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Live sessions you host on batch0 — your camera and screen, students
        watching. They can&rsquo;t see each other or how many are here.{" "}
        <Link
          href="/admin/events"
          className="text-phosphor-ink hover:underline"
        >
          All events →
        </Link>
      </p>
      {children}
    </div>
  );
}
