"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, ExternalLink, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ChallengeCover } from "@/components/challenges/cover";
import { getActionError } from "@/lib/action-error";
import {
  CHALLENGE_KINDS,
  COVER_THEMES,
  KIND_LABELS,
  MAX_REFERRALS_REQUIRED,
  isInputQuestion,
  prizeHeadline,
  type ChallengeKind,
  type CoverTheme,
  type ChallengePrize,
  type FaqItem,
  type ResourceLink,
  type ScheduleItem,
} from "@/lib/challenges-shared";
import { saveChallenge, type ChallengeInput } from "./actions";
import { ChallengeQuestionBuilder, type DraftQuestion } from "./challenge-question-builder";
import { PrizeBuilder } from "./prize-builder";
import { ImageField } from "./image-field";
import {
  FaqBuilder,
  ResourceBuilder,
  ScheduleBuilder,
  isoToLocalInput,
  localInputToIso,
} from "./list-builders";
import type { ChallengeEditorInitial } from "./challenge-initial";

const SECTIONS = [
  ["basics", "Basics"],
  ["cover", "Cover"],
  ["when", "Dates & place"],
  ["prizes", "Prizes"],
  ["entry", "Entry rules"],
  ["form", "Submission form"],
  ["details", "Rules, FAQ, links"],
  ["banner", "Homepage banner"],
  ["winners", "Winners"],
] as const;

const THEME_SWATCH: Record<CoverTheme, string> = {
  phosphor: "bg-phosphor",
  ink: "bg-[#141414]",
  paper: "bg-paper",
};

export function ChallengeEditor({ initial }: { initial: ChallengeEditorInitial | null }) {
  const router = useRouter();
  const [kind, setKind] = useState<ChallengeKind>(initial?.kind ?? "hackathon");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tagline, setTagline] = useState(initial?.tagline ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(initial?.coverImageUrl ?? null);
  const [coverTheme, setCoverTheme] = useState<CoverTheme>(initial?.coverTheme ?? "phosphor");
  const [location, setLocation] = useState(initial?.location ?? "Online");
  const [locationUrl, setLocationUrl] = useState(initial?.locationUrl ?? "");
  const [opensAt, setOpensAt] = useState(isoToLocalInput(initial?.opensAt));
  const [closesAt, setClosesAt] = useState(isoToLocalInput(initial?.closesAt));
  const [resultsAt, setResultsAt] = useState(isoToLocalInput(initial?.resultsAt));
  const [schedule, setSchedule] = useState<ScheduleItem[]>(initial?.schedule ?? []);
  const [prizes, setPrizes] = useState<ChallengePrize[]>(initial?.prizes ?? []);
  const [prizeLabel, setPrizeLabel] = useState(initial?.prizeLabel ?? "");
  const [referralsRequired, setReferralsRequired] = useState(initial?.referralsRequired ?? 0);
  const [allowEdits, setAllowEdits] = useState(initial?.allowEdits ?? true);
  // New challenges start with NO questions: a random id minted in useState
  // would differ between SSR and hydration. Ids are minted on click only.
  const [questions, setQuestions] = useState<DraftQuestion[]>(initial?.questions ?? []);
  const [rules, setRules] = useState(initial?.rules ?? "");
  const [faq, setFaq] = useState<FaqItem[]>(initial?.faq ?? []);
  const [resources, setResources] = useState<ResourceLink[]>(initial?.resources ?? []);
  const [featured, setFeatured] = useState(initial?.featured ?? false);
  const [marqueeText, setMarqueeText] = useState(initial?.marqueeText ?? "");
  const [ctaLabel, setCtaLabel] = useState(initial?.ctaLabel ?? "Register");
  const [ctaHref, setCtaHref] = useState(initial?.ctaHref ?? "");
  const [winnersPublished, setWinnersPublished] = useState(initial?.winnersPublished ?? false);

  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>();

  const payload: ChallengeInput = {
    id: initial?.id,
    slug: slug.trim() || undefined,
    kind,
    title,
    tagline,
    description,
    cover_image_url: coverImageUrl,
    cover_theme: coverTheme,
    location,
    location_url: locationUrl.trim() || null,
    prize_label: prizeLabel,
    prizes,
    marquee_text: marqueeText,
    cta_label: ctaLabel,
    cta_href: ctaHref.trim() || null,
    opens_at: localInputToIso(opensAt),
    closes_at: localInputToIso(closesAt),
    results_at: localInputToIso(resultsAt),
    schedule,
    rules,
    faq,
    resources,
    questions,
    referrals_required: referralsRequired,
    allow_edits: allowEdits,
    featured,
    winners_published: winnersPublished,
  };
  const snapshot = JSON.stringify(payload);
  const [baseline, setBaseline] = useState(snapshot);
  const dirty = snapshot !== baseline;

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  // In-app links (the tabs above, "All challenges", the sidebar) are client
  // navigations that beforeunload never sees. Catch them while dirty.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (formRef.current?.contains(a) && a.getAttribute("href")?.startsWith("#")) return;
      if (a.origin !== window.location.origin) return;
      if (!window.confirm("You have unsaved changes. Leave without saving?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  function save(e?: React.FormEvent) {
    e?.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        const res = await saveChallenge(payload);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Adopt what the server actually stored (deduped slug, blank rows
        // skipped, lists normalised), so "saved" means what's on screen is
        // what's live — and none of it reads as an unsaved change.
        const d = res.data;
        if (d) {
          setSlug(d.slug);
          setSchedule(d.schedule);
          setFaq(d.faq);
          setResources(d.resources);
          setPrizes(d.prizes);
          setQuestions(d.questions);
          setBaseline(
            JSON.stringify({
              ...payload,
              slug: d.slug || payload.slug,
              prizes: d.prizes,
              schedule: d.schedule,
              faq: d.faq,
              resources: d.resources,
              questions: d.questions,
            }),
          );
        } else {
          setBaseline(snapshot);
        }
        setSavedAt(Date.now());
        if (!initial?.id && d?.id) {
          router.push(`/admin/challenges/${d.id}/edit`);
        } else {
          router.refresh();
        }
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Through the form, so the browser's own validation (e.g. a half-typed
        // date) runs exactly as it does for the Save button.
        if (!pending) formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const headlinePreview = useMemo(
    () => prizeHeadline({ prizeLabel: "", prizes }),
    [prizes],
  );
  const marqueePreview =
    marqueeText.trim() ||
    [title.trim(), (prizeLabel || headlinePreview).trim()].filter(Boolean).join(" — ") ||
    "Your banner text will appear here";

  return (
    <form ref={formRef} onSubmit={save} className="grid gap-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <nav className="hidden lg:block">
        <ul className="sticky top-24 space-y-0.5 text-[13px]">
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="block rounded-md px-2.5 py-1.5 text-ink-soft hover:bg-wash hover:text-ink">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 space-y-10">
        <Section id="basics" title="Basics">
          <Field label="Type">
            <div className="inline-flex rounded-md border border-line p-0.5" role="radiogroup">
              {CHALLENGE_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                  className={`rounded px-3 py-1.5 text-[13px] font-medium ${kind === k ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <Hint>Just the label on the page. All three work the same: register, submit, win.</Hint>
          </Field>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Build an AI tutor in a weekend" />
          </Field>
          <Field label="Tagline">
            <Input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="One line under the title — who it's for and what to build" maxLength={200} />
          </Field>
          <Field label="URL">
            <div className="flex items-center rounded-md border border-line bg-paper focus-within:border-phosphor focus-within:ring-2 focus-within:ring-phosphor/30">
              <span className="pl-3 font-mono text-[12px] text-ink-faint">/challenges/</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="auto from title"
                className="h-10 min-w-0 flex-1 bg-transparent pr-3 font-mono text-[13px] text-ink outline-none"
              />
            </div>
          </Field>
          <Field label="About">
            <Textarea
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={"What's the prompt? What are you looking for? What makes a great entry?\n\n**Markdown works** — lists, bold, links."}
            />
            <Hint>Markdown supported. Shown in the About section.</Hint>
          </Field>
        </Section>

        <Section id="cover" title="Cover">
          <div className="grid gap-6 sm:grid-cols-[220px_minmax(0,1fr)]">
            <div className="w-full max-w-[220px]">
              <ChallengeCover title={title || "Your title"} kind={kind} imageUrl={coverImageUrl} theme={coverTheme} footer={prizeLabel || headlinePreview} />
            </div>
            <div className="space-y-5">
              <Field label="Upload a cover (square works best)">
                <ImageField value={coverImageUrl} onChange={setCoverImageUrl} label="Cover" compact />
              </Field>
              {!coverImageUrl && (
                <Field label="Or use a typographic cover">
                  <div className="flex gap-2">
                    {COVER_THEMES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        aria-label={`${t} theme`}
                        aria-pressed={coverTheme === t}
                        onClick={() => setCoverTheme(t)}
                        className={`h-9 w-9 rounded-md border ${THEME_SWATCH[t]} ${coverTheme === t ? "ring-2 ring-phosphor ring-offset-2 ring-offset-paper" : "border-line"}`}
                      />
                    ))}
                  </div>
                  <Hint>Built from the title and prize. No image needed.</Hint>
                </Field>
              )}
            </div>
          </div>
        </Section>

        <Section id="when" title="Dates & place">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Submissions open">
              <Input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
              <Hint>Blank = open as soon as it&apos;s published. People can register before this.</Hint>
            </Field>
            <Field label="Submissions due">
              <Input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
              <Hint>The form locks after this.</Hint>
            </Field>
            <Field label="Winners announced">
              <Input type="datetime-local" value={resultsAt} onChange={(e) => setResultsAt(e.target.value)} />
              <Hint>Optional — shown on the timeline.</Hint>
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Location">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Online" />
            </Field>
            <Field label="Location link (optional)">
              <Input value={locationUrl} onChange={(e) => setLocationUrl(e.target.value)} placeholder="Discord invite, Maps link…" />
            </Field>
          </div>
          <Field label="Extra milestones">
            <ScheduleBuilder value={schedule} onChange={setSchedule} />
            <Hint>Kickoff calls, office hours, demo day. The three dates above are added to the timeline automatically.</Hint>
          </Field>
        </Section>

        <Section id="prizes" title="Prizes">
          <PrizeBuilder value={prizes} onChange={setPrizes} />
          <Field label="Prize headline (optional)">
            <Input value={prizeLabel} onChange={(e) => setPrizeLabel(e.target.value)} placeholder={headlinePreview || "Auto-generated from the prizes"} />
            <Hint>The one-liner on cards and the banner. Leave blank to use: {headlinePreview ? <strong className="text-ink">{headlinePreview}</strong> : "—"}</Hint>
          </Field>
        </Section>

        <Section id="entry" title="Entry rules">
          <div className="rounded-xl border border-line bg-wash p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0 max-w-md">
                <p className="text-sm font-medium text-ink">Required referrals to submit</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Entrants can register and draft freely, but can&apos;t submit until this many friends
                  have <strong>made a batch0 account</strong> through their link and either
                  <strong> registered for this challenge</strong> or <strong>applied to a cohort</strong>.
                  Only friends who join after this challenge was created count. 0 = off.
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" aria-label="Fewer" onClick={() => setReferralsRequired((n) => Math.max(0, n - 1))} className="flex h-10 w-10 items-center justify-center rounded-md border border-line bg-paper hover:bg-wash">
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={0}
                  max={MAX_REFERRALS_REQUIRED}
                  value={referralsRequired}
                  onChange={(e) => setReferralsRequired(Math.max(0, Math.min(MAX_REFERRALS_REQUIRED, Number(e.target.value) || 0)))}
                  className="h-10 w-16 rounded-md border border-line bg-paper text-center font-mono text-base text-ink"
                  aria-label="Required referrals"
                />
                <button type="button" aria-label="More" onClick={() => setReferralsRequired((n) => Math.min(MAX_REFERRALS_REQUIRED, n + 1))} className="flex h-10 w-10 items-center justify-center rounded-md border border-line bg-paper hover:bg-wash">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <Toggle
            label="Let entrants edit after submitting"
            description="They can keep improving their entry until the deadline. The version at the deadline is what you judge."
            checked={allowEdits}
            onChange={setAllowEdits}
          />
        </Section>

        <Section
          id="form"
          title="Submission form"
          action={
            initial?.id ? (
              <a href={`/challenges/${initial.slug}/submit?preview=1`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-phosphor-ink hover:underline">
                <Eye className="h-3.5 w-3.5" /> Preview form
              </a>
            ) : null
          }
        >
          {questions.filter(isInputQuestion).length === 0 && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-ink">
              Entrants can&apos;t submit until there&apos;s at least one question. For a giveaway,
              quick-add <strong>Agree to rules</strong> — that makes entering a single tick and a click.
            </p>
          )}
          <ChallengeQuestionBuilder value={questions} onChange={setQuestions} />
          <Hint>Editing questions never changes answers already submitted — each entry keeps a copy of the form it was submitted against.</Hint>
        </Section>

        <Section id="details" title="Rules, FAQ, links">
          <Field label="Rules & eligibility">
            <Textarea rows={5} value={rules} onChange={(e) => setRules(e.target.value)} placeholder={"- Open to high school students\n- Build it during the challenge window\n- Teams up to 4"} />
            <Hint>Markdown supported.</Hint>
          </Field>
          <Field label="FAQ">
            <FaqBuilder value={faq} onChange={setFaq} />
          </Field>
          <Field label="Resources">
            <ResourceBuilder value={resources} onChange={setResources} />
            <Hint>Starter kits, APIs, templates, a Discord invite.</Hint>
          </Field>
        </Section>

        <Section id="banner" title="Homepage banner">
          <Toggle
            label="Feature in the homepage banner"
            description="When several are live, a featured one takes the banner. Otherwise the one closing soonest does."
            checked={featured}
            onChange={setFeatured}
          />
          <Field label="Banner text">
            <Input value={marqueeText} onChange={(e) => setMarqueeText(e.target.value)} placeholder="Win Meta AI glasses — build something this week" />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Button label">
              <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Register" />
            </Field>
            <Field label="Button link (optional)">
              <Input value={ctaHref} onChange={(e) => setCtaHref(e.target.value)} placeholder={`/challenges/${slug || "…"}`} />
            </Field>
          </div>
          <div className="overflow-hidden rounded-md border border-on-phosphor/15">
            <div className="flex items-center gap-3 bg-phosphor px-4 py-2 text-on-phosphor">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">⚡ {KIND_LABELS[kind]}</span>
              <span className="truncate text-[13px]">{marqueePreview}</span>
              <span className="ml-auto shrink-0 text-[13px] font-semibold underline decoration-on-phosphor/40 underline-offset-2">{ctaLabel || "Register"} →</span>
            </div>
          </div>
        </Section>

        <Section id="winners" title="Winners">
          <Toggle
            label="Publish winners publicly"
            description="Shows the winners you mark as public on this page and in the site-wide winners strip. Each winner is opt-in on their submission."
            checked={winnersPublished}
            onChange={setWinnersPublished}
          />
        </Section>

        {/* Sticky save bar */}
        <div className="sticky bottom-0 z-30 -mx-2 rounded-t-xl border border-b-0 border-line bg-paper/95 px-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 px-3 py-3">
            <Button type="submit" disabled={pending || (!dirty && !!initial?.id)}>
              {pending ? "Saving…" : initial?.id ? (dirty ? "Save changes" : "Saved") : "Create draft"}
            </Button>
            {initial?.id && (
              <a href={`/challenges/${initial.slug}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink">
                View page <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <span className="text-xs text-ink-faint">
              {dirty ? "Unsaved changes · ⌘S to save" : savedAt ? "All changes saved" : ""}
            </span>
            {error && (
              <p className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300 sm:w-auto">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>

    </form>
  );
}

function Section({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-line pb-2">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">{title}</h3>
        {action}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-xs text-ink-faint">{children}</p>;
}
