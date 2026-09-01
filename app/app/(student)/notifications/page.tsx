import { ArrowUpRight, CheckCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { LocalTime } from "@/components/ui/local-time";
import { markAllNotificationsRead } from "@/app/notifications/actions";
import { AppHeader, AppBody, Section, Row, Empty } from "@/components/app/frame";

export const metadata = { title: "Notifications · batch0" };
export const dynamic = "force-dynamic";

/**
 * The inbox behind the bell on Home.
 *
 * This screen exists because /notifications is a dead end from the app. That
 * page is `max-w-3xl` with no tab bar, and its only exit resolves `home`
 * through roleHome() — which validates against ROLE_HOME_OPTIONS
 * (/admin, /dashboard, /mentor, /investor). `/app` is not representable in that
 * type, so "Back" from the most-tapped control in the product always landed a
 * student one level DEEPER in the desktop. roleHome drives every post-login
 * redirect, so the fix is a screen inside the shell, not a patch there: here
 * the tab bar IS the exit and there is no back link to get wrong.
 */

/**
 * Notification links are written by ~20 server actions and almost all of them
 * point at /dashboard/* (grep `link:` — admissions, stripe-fulfillment, charges,
 * applications, events all do). Following one raw would drop the reader out of
 * the app shell on the very tap this screen was built to keep in it, so the
 * ones with an in-app equivalent are rewritten and the rest are marked as
 * leaving. Query strings are dropped on a rewrite: none of the writers attach
 * one, and an /app screen would not read it if they did.
 */
const IN_APP_EQUIVALENT: Record<string, string> = {
  "/dashboard": "/app/home",
  "/dashboard/course": "/app/course",
  "/dashboard/checkin": "/app/checkin",
  "/dashboard/events": "/app/events",
  "/dashboard/announcements": "/app/announcements",
  "/dashboard/billing": "/app/billing",
};

type Destination = {
  href?: string;
  /** Leaves the installed app — either the desktop dashboard or another site. */
  leaves: boolean;
  /** Needs target="_blank" rather than a client-side navigation. */
  offsite: boolean;
};

function destinationFor(link: string | null): Destination {
  if (!link) return { leaves: false, offsite: false };
  // A few notifiers write `${env.siteUrl}/admin/...` rather than a path. Those
  // are addressed to staff so a student's list should never hold one, but an
  // absolute URL handed to <Link> is a full page load either way — treat it as
  // what it is.
  if (/^https?:\/\//i.test(link)) return { href: link, leaves: true, offsite: true };
  const path = link.split(/[?#]/)[0];
  const mapped = IN_APP_EQUIVALENT[path];
  if (mapped) return { href: mapped, leaves: false, offsite: false };
  return { href: link, leaves: true, offsite: false };
}

export default async function StudentAppNotifications() {
  const user = await requireUser();
  // The RLS-scoped client, not createAdminClient(). Every row here is the
  // reader's own and `notifications` has a user_id policy, so the service role
  // would buy nothing and would move the ownership check from the database
  // into this file. The .eq() below and the policy then agree by construction.
  const supabase = createClient();

  // Capped at 50, where the desktop page takes 200. Same reasoning as the
  // announcements screen: notifications accumulate for the life of an account
  // and nobody scrolls to the sixtieth, so an uncapped list is a payload that
  // grows forever on the connection least able to carry it.
  const { data: items } = await supabase
    .from("notifications")
    .select("id, type, title, body, link, read_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const all = items ?? [];
  const unread = all.filter((n) => !n.read_at);
  const read = all.filter((n) => n.read_at);

  return (
    <>
      <AppHeader
        title="Notifications"
        eyebrow={unread.length > 0 ? `${unread.length} unread` : "All caught up"}
        action={
          unread.length > 0 ? (
            // A plain <form> posting a server action, so this screen ships zero
            // client JavaScript — the desktop page's MarkAllRead is a client
            // component only because it also has to call router.refresh(), and
            // the revalidatePath in the action covers that here.
            //
            // Icon-only with an aria-label, matching the bell on Home and the
            // admin shield on More: at 1.75rem the display-face title already
            // spends most of a 320px header, and a "Mark all read" label beside
            // it truncates the page's own name.
            <form action={markAllNotificationsRead}>
              <button
                type="submit"
                aria-label={`Mark all ${unread.length} notifications read`}
                className="press inline-flex h-11 w-11 items-center justify-center rounded-lg border border-line text-ink-soft active:bg-wash"
              >
                <CheckCheck className="h-4 w-4" />
              </button>
            </form>
          ) : undefined
        }
      />
      <AppBody>
        {all.length === 0 ? (
          <Empty>
            Nothing yet. Decisions, payments and anything the team posts land
            here.
          </Empty>
        ) : (
          <>
            {unread.length > 0 && (
              <Section title="Unread">
                <div className="rounded-2xl border border-line px-4 sm:px-5">
                  {unread.map((n) => (
                    <NotificationRow key={n.id} n={n} />
                  ))}
                </div>
              </Section>
            )}
            {read.length > 0 && (
              <Section title="Earlier">
                <div className="rounded-2xl border border-line px-4 sm:px-5">
                  {read.map((n) => (
                    <NotificationRow key={n.id} n={n} />
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </AppBody>
    </>
  );
}

type NotificationRowData = {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

/**
 * One notification, as navigation.
 *
 * Tapping does NOT mark the row read, which the desktop list does. There it
 * costs a client component that intercepts the tap, awaits a write and only
 * then pushes — a visible stall on cellular, on the one interaction that has
 * to feel instant. Here the row is a link and reading is a bulk act from the
 * header, which is also the only thing that clears the badge people actually
 * care about.
 */
function NotificationRow({ n }: { n: NotificationRowData }) {
  const dest = destinationFor(n.link);
  const isUnread = !n.read_at;
  return (
    <Row
      label={n.title}
      // The timestamp is a `meta` line, not a `right` slot. `right` is not
      // inside the min-w-0 column, so it never shrinks: "Aug 30, 3:45 PM" is
      // 15 mono glyphs, about 99px, and out of the 248px a row has at 320px
      // that left the title roughly seven characters before `truncate` took
      // the rest. `meta` is the mono timestamp line the Events list already
      // uses for exactly this, and it truncates itself instead of taking width
      // off the thing that identifies the notification.
      meta={<LocalTime value={n.created_at} mode="datetime-short" />}
      // The body goes in `below`, never in `value`: `value` renders with
      // `truncate`, so a two-line notification body would come out as one
      // clipped line — and it cannot go in `meta` either, since that is a <p>
      // and a block child there is invalid nesting that throws a hydration
      // mismatch.
      below={
        n.body ? (
          <p
            className={`line-clamp-2 break-words text-[13.5px] leading-relaxed [overflow-wrap:anywhere] ${
              isUnread ? "text-ink-soft" : "text-ink-faint"
            }`}
          >
            {n.body}
          </p>
        ) : undefined
      }
      href={dest.href}
      external={dest.offsite}
      // In-app destinations sit under (student)/loading.tsx, so a prefetch has
      // a boundary to pay for itself against; a /dashboard route in this list
      // is a one-off whose prefetched render would be thrown away under
      // staleTimes.dynamic = 0.
      prefetch={dest.leaves ? false : undefined}
      leading={
        isUnread ? (
          // Decoration only — the "Unread" section heading above already
          // carries this for anyone not looking at the dot.
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full bg-phosphor"
          />
        ) : undefined
      }
      muted={!isUnread}
      // Only the leaving-the-app marker, matching the Events list, where the
      // right slot is one small icon and everything else is text in the
      // shrinkable column.
      right={
        dest.leaves ? (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        ) : undefined
      }
    />
  );
}
