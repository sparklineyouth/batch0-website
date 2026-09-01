import { Fragment } from "react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { getCohortAnnouncements } from "@/lib/app-cache";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Empty, Alert } from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Announcements · batch0" };
export const dynamic = "force-dynamic";

/** Split on the URL so String.split keeps it: text, url, text, url, … */
const URL_SPLIT = /(https?:\/\/[^\s<]+)/g;

/**
 * Make bare URLs in an announcement body tappable.
 *
 * The composer offers no rich-text affordance and `announcements` has no link
 * column (lib/app-cache.ts selects id/title/body/created_at), so "here's the
 * link" pasted into the body is this channel's single most common payload —
 * and it was rendering as dead text you cannot select comfortably, let alone
 * open, on a phone.
 *
 * Done here in the server component: no markdown dependency, no client bundle,
 * and this page stays 100% RSC apart from the shared <LocalTime>.
 */
function linkify(body: string) {
  return body.split(URL_SPLIT).map((seg, i) => {
    // Odd indices are the captured URLs; even indices are the prose between.
    if (i % 2 === 0 || !seg) return seg;
    // Sentence punctuation gets swallowed by `[^\s<]+`. "…see https://x/doc."
    // must link the doc, not doc-plus-full-stop — and the stripped characters
    // are re-emitted as text so the sentence still reads correctly.
    const url = seg.replace(/[.,;:!?)\]]+$/, "");
    if (!url) return seg;
    return (
      <Fragment key={i}>
        {/* inline-block, and no `press`. The coarse-pointer min-height rule in
            globals.css only matches `a.press`, and min-height is a no-op on a
            non-replaced inline box anyway — so `press` here would buy nothing
            but the scale animation. inline-block also stops the anchor from
            fragmenting into thin line-boxes inside this paragraph's
            [overflow-wrap:anywhere]. This is the one accepted miss on the 44px
            floor: an inline link in prose cannot be 44px tall without wrecking
            the line rhythm of the text it sits in. `break-all` keeps a long
            join URL from pushing the card sideways. */}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block break-all py-0.5 text-phosphor-ink underline decoration-phosphor/40 underline-offset-2 active:opacity-70"
        >
          {url}
        </a>
        {seg.slice(url.length)}
      </Fragment>
    );
  });
}

/**
 * Past this age a post prints its full date instead of a time of day.
 *
 * `datetime-short` omits the year (components/ui/local-time.tsx), so a post
 * from last cohort read as "Jan 3, 4:15 PM" — indistinguishable from this
 * morning. What time of day something was announced stops mattering long
 * before a year is out; what year it was announced starts mattering.
 *
 * The comparison runs on the server, in the server timezone. That is fine at
 * this granularity — nobody can perceive a day of slop around an eleven-month
 * cutoff — but it would be wrong the moment someone tightens it to "older than
 * two days", which needs the viewer's clock and therefore a client component.
 */
const DATE_ONLY_AFTER_MS = 330 * 24 * 60 * 60 * 1000;

/**
 * Announcements, read-only.
 *
 * The desktop page also carries emoji reactions (migration 0027). They're
 * omitted here on purpose: reacting is a social nicety, reading is the job, and
 * every reaction control is another 44px target competing with the text on a
 * 390px screen. Reactions still work from /dashboard/announcements.
 *
 * Capped at 30. Announcements accumulate for the life of a cohort and nobody
 * scrolls to the fortieth; an uncapped list is a payload that grows forever on
 * the connection least able to carry it.
 */
export default async function StudentAppAnnouncements() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);

  // ENROLLMENT GATE — must stay above any query. Same reasoning as
  // app/app/(student)/events/page.tsx: the reads below run through
  // createAdminClient() with the service role, so the `announcements` RLS
  // policy from migration 0027 (which requires a row in `enrollments` for BOTH
  // the cohort-scoped and the global branch) never applies. This check is the
  // enforcement, not a convenience.
  //
  // lib/nav-config.ts already lists /dashboard/announcements in
  // ENROLLED_ONLY_HREFS for exactly this reason, and
  // /dashboard/announcements renders <LockedFeature> here.
  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Announcements" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="Announcements open at enrollment.">
            This is how the team reaches your cohort — it unlocks once your seat
            is paid for.
          </Alert>
        </AppBody>
      </>
    );
  }
  // Mirrors the RLS policy on `announcements`: cohort-scoped posts plus the
  // global ones. A student with no cohort sees only the global posts rather
  // than an error. Cached per cohort (lib/app-cache.ts) — staff-authored
  // content that a whole cohort reads, so it is shared rather than re-queried
  // for each of them.
  //
  // Capped at 30. Announcements accumulate for the life of a cohort and nobody
  // scrolls to the fortieth; an uncapped list is a payload that grows forever
  // on the connection least able to carry it.
  const announcements = await getCohortAnnouncements(
    { cohortId: access.cohortId },
    30,
  );

  // Read once, not per card, so two posts a millisecond apart can't land on
  // opposite sides of the cutoff. NaN from an unparseable timestamp fails the
  // comparison and falls back to the short format, which is the safe default.
  const now = Date.now();

  return (
    <>
      <AppHeader title="Announcements" eyebrow="From the batch0 team" />
      <AppBody>
        {(announcements ?? []).length === 0 ? (
          <Empty>Nothing announced yet.</Empty>
        ) : (
          <div className="space-y-3">
            {(announcements ?? []).map((a) => (
              <article
                key={a.id as string}
                className="rounded-2xl border border-line bg-wash px-5 py-4"
              >
                {/* h2 under the header's h1 (frame.tsx). These are children of
                    the page title, not siblings of it. */}
                <h2 className="text-[15px] font-medium leading-snug text-ink">
                  {a.title as string}
                </h2>
                <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-soft [overflow-wrap:anywhere]">
                  {linkify(a.body as string)}
                </p>
                <p className="mt-3 font-mono text-[11px] tabular-nums text-ink-faint">
                  <LocalTime
                    value={a.created_at as string}
                    mode={
                      now - Date.parse(a.created_at as string) >
                      DATE_ONLY_AFTER_MS
                        ? "date"
                        : "datetime-short"
                    }
                  />
                </p>
              </article>
            ))}
          </div>
        )}
      </AppBody>
    </>
  );
}
