import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicSiteConfig } from "@/lib/site-config";
import { renderSafeMarkdown } from "@/lib/markdown-safe";
import {
  QUESTION_PRESETS,
  blankQuestion,
  rowToSubmission,
  type Challenge,
} from "@/lib/challenges-shared";
import type { EntrantState } from "@/lib/challenges";
import { EventView } from "@/app/challenges/[slug]/event-view";
import { SubmissionForm } from "@/app/challenges/[slug]/submit/submission-form";
import { ChallengeCover } from "@/components/challenges/cover";
import { ChallengeEditor } from "@/app/admin/challenges/challenge-editor";
import { challengeToInitial } from "@/app/admin/challenges/challenge-initial";

/**
 * Interface preview for the challenge event page and submission form, against
 * fixtures — no auth, no database writes, every state one URL away.
 *
 * Gated like app/dev/apply: renders on localhost and branch previews, 404s on
 * production (VERCEL_ENV, not NODE_ENV — see app/dev/live).
 *
 *   ?view=event|submit|editor   (editor saves are still permission-checked)
 *   ?state=signedout|signedin|registered|draft|submitted|winner|closed
 *   ?gate=N        referrals required (default 3); ?refs=N referrals made
 *   ?phase=live|upcoming|ended
 */
export const metadata = {
  title: "Challenge preview · batch0",
  robots: { index: false, follow: false },
};

const DAY = 86_400_000;

function fixture(phase: string, gate: number): Challenge {
  const now = Date.now();
  const opens = phase === "upcoming" ? now + 3 * DAY : now - 2 * DAY;
  const closes = phase === "ended" ? now - DAY : opens + 7 * DAY;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "build-with-ai-weekend",
    kind: "hackathon",
    title: "Build with AI Weekend",
    tagline: "Ship an AI tool your classmates would actually use. Solo or teams of up to 4.",
    description:
      "Use any AI model to build something **useful for students** — a study tool, a club organiser, a college-essay coach. It doesn't have to be finished; it has to *work*.\n\n**What we look for**\n\n- It solves a real problem you or your friends have\n- You can demo it in under 3 minutes\n- You shipped it — a link we can click beats a slide\n\nNo experience needed. We'll share starter templates in the resources below.",
    coverImageUrl: null,
    coverTheme: "phosphor",
    location: "Online",
    locationUrl: null,
    prizeLabel: "",
    prizeAmountCents: 75000,
    prizes: [
      { id: "p1", place: "Grand prize", kind: "item", title: "Ray-Ban Meta AI glasses", description: "Shipped to your door (US).", valueCents: 29900, quantity: 1, imageUrl: null },
      { id: "p2", place: "1st place", kind: "cash", title: "", description: "", valueCents: 50000, quantity: 1, imageUrl: null },
      { id: "p3", place: "Runner-up", kind: "cash", title: "", description: "", valueCents: 12500, quantity: 2, imageUrl: null },
      { id: "p4", place: "Every finalist", kind: "perk", title: "1:1 call with a founder", description: "30 minutes with someone who's shipped.", valueCents: null, quantity: 10, imageUrl: null },
    ],
    marqueeText: "",
    ctaLabel: "Register",
    ctaHref: null,
    status: phase === "ended" ? "closed" : "active",
    opensAt: new Date(opens).toISOString(),
    closesAt: new Date(closes).toISOString(),
    resultsAt: new Date(closes + 5 * DAY).toISOString(),
    schedule: [
      { id: "s1", at: new Date(opens + 2 * 3600_000).toISOString(), label: "Kickoff call", detail: "Live on Discord — ideas, teams, Q&A.", url: "https://discord.gg/example" },
      { id: "s2", at: new Date(opens + 4 * DAY).toISOString(), label: "Office hours", detail: "Get unstuck with a mentor.", url: "" },
    ],
    rules: "- Open to high school students anywhere\n- Build it during the challenge window\n- Teams up to 4 — list everyone on the form",
    faq: [
      { id: "f1", q: "Do I need to know how to code?", a: "No. No-code tools are fine — we judge what it does, not how." },
      { id: "f2", q: "Can I submit something I started before?", a: "Yes, as long as you meaningfully build on it during the weekend. Tell us what's new." },
    ],
    resources: [
      { id: "r1", label: "Starter template (Next.js + AI SDK)", url: "https://github.com/example/starter", description: "Clone, add a key, deploy." },
    ],
    questions: [
      ...["project_name", "pitch", "description", "demo_link", "repo", "video", "screenshots", "team", "built_with"].map(
        (k) => ({ ...QUESTION_PRESETS.find((p) => p.key === k)!.make(), id: k }),
      ),
      blankQuestion({ id: "confidence", type: "scale", label: "How ready is it?", scaleMax: 5, scaleMinLabel: "Rough idea", scaleMaxLabel: "People use it" }),
      { ...QUESTION_PRESETS.find((p) => p.key === "rules")!.make(), id: "rules" },
    ],
    referralsRequired: gate,
    allowEdits: true,
    featured: true,
    winnersPublished: phase === "ended",
    createdAt: new Date(now - 10 * DAY).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export default async function ChallengePreviewPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const sp = await props.searchParams;
  const view = sp.view === "submit" || sp.view === "editor" ? sp.view : "event";
  const state = sp.state ?? "signedout";
  // A decision is only visible once winners are published, so the "winner"
  // state previews a finished challenge.
  const phase = sp.phase ?? (state === "closed" || state === "winner" ? "ended" : "live");
  const gate = sp.gate != null ? Number(sp.gate) : 3;
  const refs = sp.refs != null ? Number(sp.refs) : 1;
  const c = fixture(phase, gate);

  const answers = {
    project_name: "StudyBuddy",
    pitch: "An AI tutor that quizzes you on your own class notes",
    description: "Upload notes, get spaced-repetition quizzes.",
    demo_link: "https://studybuddy.vercel.app",
    built_with: ["JavaScript / TypeScript", "AI APIs (OpenAI, Claude, …)"],
  };
  const subStatus =
    state === "draft" ? "draft" : state === "submitted" ? "submitted" : state === "winner" ? "funded" : null;
  const submission = subStatus
    ? rowToSubmission({
        id: "sub",
        challenge_id: c.id,
        user_id: "me",
        answers,
        questions_snapshot: c.questions,
        status: subStatus,
        submitted_at: subStatus === "draft" ? null : new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    : null;
  const signedIn = state !== "signedout";
  const entrant: EntrantState | null = signedIn
    ? {
        registered: state !== "signedin",
        registeredAt: null,
        submission,
        referralCode: "demo1234",
        fullName: "Maya Rodriguez",
      }
    : null;
  const link = "http://localhost:3000/challenges/build-with-ai-weekend?ref=demo1234";

  const nav = (
    <div className="border-b border-dashed border-line bg-wash px-5 py-2 font-mono text-[11px] text-ink-soft">
      preview ·{" "}
      {["signedout", "signedin", "registered", "draft", "submitted", "winner", "closed"].map((s) => (
        <Link key={s} href={`?view=${view}&state=${s}&gate=${gate}&refs=${refs}`} className={`mr-2 underline ${s === state ? "font-bold text-ink" : ""}`}>
          {s}
        </Link>
      ))}
      · <Link href={`?view=${view === "event" ? "submit" : "event"}&state=${state}&gate=${gate}&refs=${refs}`} className="underline">{view === "event" ? "→ submit form" : "→ event page"}</Link>
    </div>
  );

  if (view === "editor") {
    return (
      <div className="min-h-screen bg-paper px-5 py-8 md:px-10">
        {nav}
        <div className="mx-auto mt-6 max-w-5xl">
          <ChallengeEditor initial={challengeToInitial(c)} />
        </div>
      </div>
    );
  }

  if (view === "submit") {
    return (
      <div className="min-h-screen bg-paper">
        {nav}
        <SubmissionForm
          challenge={{
            slug: c.slug,
            title: c.title,
            kindLabel: "Hackathon",
            kind: c.kind,
            questions: c.questions,
            status: c.status,
            opensAt: c.opensAt,
            closesAt: c.closesAt,
            allowEdits: c.allowEdits,
            referralsRequired: c.referralsRequired,
          }}
          cover={<ChallengeCover title={c.title} kind={c.kind} imageUrl={null} theme={c.coverTheme} size="xs" />}
          initialAnswers={submission?.answers ?? {}}
          initialStatus={submission?.status ?? null}
          initialSubmittedAt={submission?.submittedAt ?? null}
          initialVersion={submission?.updatedAt ?? null}
          initialPreviews={{}}
          referral={
            gate > 0
              ? {
                  required: gate,
                  count: refs,
                  friends: Array.from({ length: refs }, (_, i) => ({
                    name: ["Jordan K.", "Priya S.", "Leo M.", "Ana T."][i % 4],
                    source: i % 2 ? ("applied" as const) : ("registered" as const),
                    at: new Date().toISOString(),
                  })),
                  link,
                }
              : null
          }
          preview
        />
      </div>
    );
  }

  const [config, descriptionHtml, rulesHtml] = await Promise.all([
    getPublicSiteConfig(),
    renderSafeMarkdown(c.description),
    renderSafeMarkdown(c.rules),
  ]);
  return (
    <>
      {nav}
      <EventView
        challenge={c}
        config={config}
        registrationCount={128}
        entrant={entrant}
        winners={
          phase === "ended"
            ? [
                { id: "w1", challengeSlug: c.slug, challengeTitle: c.title, publicName: "Maya R.", publicBlurb: "StudyBuddy — AI quizzes from your own notes", publicProjectUrl: "https://example.com", payoutAmountCents: null, awardLabel: "Grand prize — Ray-Ban Meta AI glasses", fundedAt: null },
                { id: "w2", challengeSlug: c.slug, challengeTitle: c.title, publicName: "Dev P.", publicBlurb: "ClubHub — one inbox for every club", publicProjectUrl: null, payoutAmountCents: 50000, awardLabel: "1st place — $500", fundedAt: null },
              ]
            : []
        }
        descriptionHtml={descriptionHtml}
        rulesHtml={rulesHtml}
        referral={signedIn && state !== "signedin" ? { link, count: refs } : null}
        signedIn={signedIn}
        autoJoin={false}
        refCode={null}
      />
    </>
  );
}
