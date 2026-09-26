import Link from "next/link";
import {
  ArrowLeft,
  ExternalLink,
  MapPin,
  Trophy,
  Users,
  UserPlus,
} from "lucide-react";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { env } from "@/lib/env";
import type { SiteConfig } from "@/lib/site-config";
import {
  challengePhase,
  googleCalendarUrl,
  prizeHeadline,
  formatCents,
  KIND_LABELS,
  type Challenge,
  type PublicWinner,
} from "@/lib/challenges-shared";
import type { EntrantState } from "@/lib/challenges";
import { ChallengeCover } from "@/components/challenges/cover";
import { PrizeGrid } from "@/components/challenges/prize-grid";
import { DateTile, EventWhen, PhasePill } from "@/components/challenges/time";
import { LocalTime } from "@/components/ui/local-time";
import { RegisterCard } from "./register-card";

/**
 * The event page, as a pure view of already-fetched data. The route
 * (page.tsx) does the reads; app/dev/challenge renders this same component
 * against fixtures so every state can be looked at without an account.
 */
export function EventView({
  challenge,
  config,
  registrationCount,
  entrant,
  winners,
  descriptionHtml: description,
  rulesHtml: rules,
  referral,
  signedIn,
  autoJoin,
  refCode,
}: {
  challenge: Challenge;
  config: SiteConfig;
  registrationCount: number;
  entrant: EntrantState | null;
  winners: PublicWinner[];
  descriptionHtml: string;
  rulesHtml: string;
  referral: { link: string; count: number } | null;
  signedIn: boolean;
  autoJoin: boolean;
  refCode: string | null;
}) {
  const pageUrl = `${env.siteUrl}/challenges/${challenge.slug}`;
  const phase = challengePhase(challenge);
  const headline = prizeHeadline(challenge);
  const kindLabel = KIND_LABELS[challenge.kind];
  const timeline = buildTimeline(challenge);

  return (
    <div className="min-h-screen bg-paper">
      <Navbar cohortLabel={config.derived.cohortLabel || "the next cohort"} />
      <main id="main-content" tabIndex={-1}>
        {challenge.status === "draft" && (
          <div className="border-b border-line bg-wash px-5 py-2 text-center text-[13px] text-ink-soft">
            Draft preview — only staff can see this page.{" "}
            <Link href={`/admin/challenges/${challenge.id}/edit`} className="font-medium text-ink underline decoration-phosphor decoration-2">
              Edit
            </Link>
          </div>
        )}
        <div className="mx-auto max-w-[1100px] px-5 pb-24 pt-6 sm:px-6 md:pt-10">
          <Link
            href="/challenges"
            className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All challenges
          </Link>

          <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,330px)_minmax(0,1fr)] md:gap-12">
            {/* Left rail — cover + host. Sticky on desktop, like an event page. */}
            <aside className="md:sticky md:top-24 md:self-start">
              <ChallengeCover
                title={challenge.title}
                kind={challenge.kind}
                imageUrl={challenge.coverImageUrl}
                theme={challenge.coverTheme}
                footer={headline}
              />
              <div className="mt-5 hidden space-y-4 md:block">
                <HostBlock />
                <GoingBlock count={registrationCount} />
                {config.settings.contactEmail && (
                  <p className="border-t border-line pt-4 text-[13px] text-ink-faint">
                    Questions?{" "}
                    <a
                      href={`mailto:${config.settings.contactEmail}`}
                      className="text-ink underline decoration-line underline-offset-2 hover:decoration-phosphor"
                    >
                      Email the team
                    </a>
                  </p>
                )}
              </div>
            </aside>

            {/* Right column — what, when, where, and the one button. */}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                  {kindLabel}
                </span>
                <PhasePill challenge={challenge} initial={phase} withCountdown />
              </div>
              <h1 className="mt-3 font-display text-[clamp(2.25rem,5.5vw,3.5rem)] leading-[1.02] text-ink [overflow-wrap:anywhere]">
                {challenge.title}
              </h1>
              {challenge.tagline && (
                <p className="mt-3 max-w-2xl text-[1.0625rem] leading-[1.55] text-ink-soft">
                  {challenge.tagline}
                </p>
              )}

              <div className="mt-6 space-y-4">
                <MetaRow icon={<DateTile iso={challenge.opensAt ?? challenge.closesAt} />}>
                  <EventWhen opensAt={challenge.opensAt} closesAt={challenge.closesAt} />
                </MetaRow>
                <MetaRow icon={<IconTile><MapPin className="h-5 w-5" /></IconTile>}>
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-medium text-ink">
                      {challenge.locationUrl ? (
                        <a
                          href={challenge.locationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          {challenge.location} <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        challenge.location
                      )}
                    </p>
                    <p className="truncate text-[13px] text-ink-soft">
                      {/online|remote|virtual/i.test(challenge.location)
                        ? "Build from anywhere"
                        : "In person"}
                    </p>
                  </div>
                </MetaRow>
                {headline && (
                  <MetaRow icon={<IconTile accent><Trophy className="h-5 w-5" /></IconTile>}>
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium text-ink">{headline}</p>
                      <p className="text-[13px] text-ink-soft">
                        {challenge.prizes.length > 1
                          ? `${challenge.prizes.length} prizes`
                          : challenge.prizes.length === 1
                            ? challenge.prizes[0].place || "Prize"
                            : "Prize"}
                      </p>
                    </div>
                  </MetaRow>
                )}
                {challenge.referralsRequired > 0 && (
                  <MetaRow icon={<IconTile><UserPlus className="h-5 w-5" /></IconTile>}>
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium text-ink">
                        Refer {challenge.referralsRequired} friend
                        {challenge.referralsRequired === 1 ? "" : "s"} to submit
                      </p>
                      <p className="text-[13px] text-ink-soft">
                        They count once they sign up and register or apply
                      </p>
                    </div>
                  </MetaRow>
                )}
              </div>

              <div className="mt-7">
                <RegisterCard
                  slug={challenge.slug}
                  kindLabel={kindLabel}
                  challenge={{
                    status: challenge.status,
                    opensAt: challenge.opensAt,
                    closesAt: challenge.closesAt,
                    resultsAt: challenge.resultsAt,
                    winnersPublished: challenge.winnersPublished,
                    allowEdits: challenge.allowEdits,
                    referralsRequired: challenge.referralsRequired,
                  }}
                  signedIn={signedIn}
                  viewerName={entrant?.fullName ?? null}
                  registered={entrant?.registered ?? false}
                  submission={
                    entrant?.submission
                      ? {
                          status: entrant.submission.status,
                          submittedAt: entrant.submission.submittedAt,
                        }
                      : null
                  }
                  referral={referral}
                  autoJoin={autoJoin}
                  refCode={refCode}
                  calendarUrl={googleCalendarUrl(challenge, pageUrl)}
                  icsUrl={`/api/challenges/${challenge.slug}/ics`}
                />
              </div>

              {/* Mobile: host + count sit under the button instead of the rail. */}
              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 md:hidden">
                <HostBlock />
                <GoingBlock count={registrationCount} />
              </div>

              {winners.length > 0 && (
                <Section title="Winners">
                  <ul className="divide-y divide-line border-y border-line">
                    {winners.map((w) => (
                      <li key={w.id} className="flex items-baseline justify-between gap-4 py-3">
                        <div className="min-w-0">
                          <p className="font-medium text-ink">
                            {w.publicName ?? "A student"}
                            {w.publicProjectUrl && (
                              <a
                                href={w.publicProjectUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-2 text-xs text-phosphor-ink underline decoration-phosphor-ink/30 underline-offset-2"
                              >
                                View →
                              </a>
                            )}
                          </p>
                          {w.publicBlurb && (
                            <p className="text-sm text-ink-soft">{w.publicBlurb}</p>
                          )}
                        </div>
                        <span className="shrink-0 text-right font-mono text-[12px] text-phosphor-ink">
                          {w.awardLabel ?? formatCents(w.payoutAmountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {description && (
                <Section title="About">
                  <div
                    className="legal-prose !text-[15px] [&>*:first-child]:!mt-0"
                    dangerouslySetInnerHTML={{ __html: description }}
                  />
                </Section>
              )}

              {challenge.prizes.length > 0 && (
                <Section title="Prizes">
                  <PrizeGrid prizes={challenge.prizes} />
                </Section>
              )}

              {timeline.length > 0 && (
                <Section title="Timeline">
                  <ol className="relative ml-1.5 border-l border-line">
                    {timeline.map((t) => (
                      <li key={t.key} className="relative pb-5 pl-6 last:pb-0">
                        <span
                          className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border ${
                            t.emphasis
                              ? "border-phosphor bg-phosphor"
                              : "border-line bg-paper"
                          }`}
                          aria-hidden
                        />
                        <p className="font-mono text-[12px] text-ink-faint">
                          <LocalTime value={t.at} mode="datetime-short" />
                        </p>
                        <p className="text-[15px] font-medium text-ink">
                          {t.url ? (
                            <a href={t.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                              {t.label} ↗
                            </a>
                          ) : (
                            t.label
                          )}
                        </p>
                        {t.detail && (
                          <p className="mt-0.5 text-[13px] text-ink-soft">{t.detail}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                </Section>
              )}

              <Section title="How to enter">
                <ol className="grid gap-3 sm:grid-cols-2">
                  {howToSteps(challenge).map((s, i) => (
                    <li key={s.title} className="flex gap-3 rounded-xl border border-line p-3.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-phosphor font-mono text-[12px] font-semibold text-on-phosphor">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold text-ink">{s.title}</p>
                        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">{s.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Section>

              {rules && (
                <Section title="Rules">
                  <div
                    className="legal-prose !text-[14px] [&>*:first-child]:!mt-0"
                    dangerouslySetInnerHTML={{ __html: rules }}
                  />
                </Section>
              )}

              {challenge.resources.length > 0 && (
                <Section title="Resources">
                  <ul className="divide-y divide-line border-y border-line">
                    {challenge.resources.map((r) => (
                      <li key={r.id}>
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex items-center justify-between gap-4 py-3"
                        >
                          <span className="min-w-0">
                            <span className="block font-medium text-ink group-hover:underline">
                              {r.label}
                            </span>
                            {r.description && (
                              <span className="block text-[13px] text-ink-soft">{r.description}</span>
                            )}
                          </span>
                          <ExternalLink className="h-4 w-4 shrink-0 text-ink-faint" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {challenge.faq.length > 0 && (
                <Section title="FAQ">
                  <div className="divide-y divide-line border-y border-line">
                    {challenge.faq.map((f) => (
                      <details key={f.id} className="group py-3">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink">
                          {f.q}
                          <span className="font-mono text-ink-faint group-open:rotate-45">+</span>
                        </summary>
                        <p className="mt-2 whitespace-pre-line text-[14px] leading-relaxed text-ink-soft">
                          {f.a}
                        </p>
                      </details>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>
        </div>
      </main>
      <Footer config={config} />
    </div>
  );
}

type TimelineItem = {
  key: string;
  at: string;
  label: string;
  detail: string;
  url: string;
  emphasis: boolean;
};

/** The dates the admin set, plus their custom milestones, in order. */
function buildTimeline(c: Challenge): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (c.opensAt)
    items.push({ key: "opens", at: c.opensAt, label: "Submissions open", detail: "", url: "", emphasis: false });
  if (c.closesAt)
    items.push({ key: "closes", at: c.closesAt, label: "Submissions due", detail: "Whatever you've submitted by now is what gets judged.", url: "", emphasis: true });
  if (c.resultsAt)
    items.push({ key: "results", at: c.resultsAt, label: "Winners announced", detail: "", url: "", emphasis: false });
  for (const s of c.schedule) {
    items.push({ key: s.id, at: s.at, label: s.label, detail: s.detail, url: s.url, emphasis: false });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function howToSteps(c: Challenge) {
  const steps = [
    {
      title: "Register",
      text: "One click with a free batch0 account. You'll get the dates by email.",
    },
  ];
  if (c.referralsRequired > 0) {
    steps.push({
      title: `Refer ${c.referralsRequired} friend${c.referralsRequired === 1 ? "" : "s"}`,
      text: "Share your link. A friend counts once they sign up and register here or apply to a cohort.",
    });
  }
  steps.push({
    title: c.kind === "giveaway" ? "Enter" : "Build & submit",
    text: c.allowEdits
      ? "The form autosaves. Submit when ready — you can edit until the deadline."
      : "The form autosaves. Submit once you're happy with it.",
  });
  steps.push({
    title: "Winners picked",
    text: c.resultsAt
      ? "We review every entry and announce winners on the date above."
      : "We review every entry and email everyone when winners are picked.",
  });
  return steps;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="mb-4 border-b border-line pb-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

function MetaRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      {icon}
      {children}
    </div>
  );
}

function IconTile({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md border ${
        accent ? "border-phosphor bg-phosphor text-on-phosphor" : "border-line bg-paper text-ink-soft"
      }`}
      aria-hidden
    >
      {children}
    </div>
  );
}

function HostBlock() {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Hosted by</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-phosphor font-display text-[15px] text-on-phosphor">
          b0
        </span>
        <span className="text-[15px] font-medium text-ink">batch0</span>
      </div>
    </div>
  );
}

function GoingBlock({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="flex items-center gap-2 text-[14px] text-ink">
      <Users className="h-4 w-4 text-ink-faint" />
      <span>
        <span className="font-semibold">{count.toLocaleString("en-US")}</span>{" "}
        <span className="text-ink-soft">registered</span>
      </span>
    </p>
  );
}
