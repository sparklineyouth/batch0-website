"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { saveChallenge, type ChallengeInput } from "./actions";
import {
  ChallengeQuestionBuilder,
  type DraftQuestion,
} from "./challenge-question-builder";
import type { ChallengeEditorInitial } from "./challenge-initial";

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function centsToDollars(cents: number | null): string {
  if (cents == null) return "";
  return String(cents / 100);
}
function dollarsToCents(dollars: string): number | null {
  const t = dollars.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function ChallengeEditor({
  initial,
}: {
  initial: ChallengeEditorInitial | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prizeLabel, setPrizeLabel] = useState(initial?.prizeLabel ?? "");
  const [prizeDollars, setPrizeDollars] = useState(
    centsToDollars(initial?.prizeAmountCents ?? null),
  );
  const [marqueeText, setMarqueeText] = useState(initial?.marqueeText ?? "");
  const [ctaLabel, setCtaLabel] = useState(initial?.ctaLabel ?? "Apply");
  const [ctaHref, setCtaHref] = useState(initial?.ctaHref ?? "");
  const [opensAt, setOpensAt] = useState(isoToLocalInput(initial?.opensAt ?? null));
  const [closesAt, setClosesAt] = useState(
    isoToLocalInput(initial?.closesAt ?? null),
  );
  const [winnersPublished, setWinnersPublished] = useState(
    initial?.winnersPublished ?? false,
  );
  // Start a NEW challenge with no questions — the builder shows an empty
  // state prompting "Add question". Critically, we must NOT generate a random
  // question id in this initial state: a client component's useState
  // initializer runs on the server (SSR) AND again on the client (hydration),
  // so a random id would differ between the two and cause a hydration
  // mismatch. Ids are only ever minted client-side, on "Add question".
  const [questions, setQuestions] = useState<DraftQuestion[]>(
    initial?.questions ?? [],
  );

  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        const payload: ChallengeInput = {
          id: initial?.id,
          slug: slug.trim() || undefined,
          title,
          description,
          prize_label: prizeLabel,
          prize_amount_cents: dollarsToCents(prizeDollars),
          marquee_text: marqueeText,
          cta_label: ctaLabel,
          cta_href: ctaHref.trim() || null,
          opens_at: localInputToIso(opensAt),
          closes_at: localInputToIso(closesAt),
          questions,
          winners_published: winnersPublished,
        };
        const res = await saveChallenge(payload);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        // A brand-new challenge now has an id — move to its edit page so
        // subsequent saves update in place (and status/submissions are linked).
        if (!initial?.id && res.data?.id) {
          router.push(`/admin/challenges/${res.data.id}/edit`);
        } else {
          router.refresh();
        }
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  const marqueePreview =
    marqueeText.trim() ||
    [title.trim(), prizeLabel.trim()].filter(Boolean).join(" — ") ||
    "Your marquee text will appear here";

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <Section title="Basics">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Build an AI tutor"
          />
        </Field>
        <Field label="URL slug">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="auto-generated from the title"
          />
          <Hint>
            The apply page lives at <code>/challenges/{slug || "…"}</code>. Leave
            blank to auto-generate.
          </Hint>
        </Field>
        <Field label="Prompt">
          <Textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's the challenge? What are you looking for? Any constraints or deadlines."
          />
          <Hint>Shown at the top of the apply page.</Hint>
        </Field>
      </Section>

      <Section title="Prize">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Prize label">
            <Input
              value={prizeLabel}
              onChange={(e) => setPrizeLabel(e.target.value)}
              placeholder="Up to $500 to build it"
            />
            <Hint>The words applicants see, e.g. on the marquee.</Hint>
          </Field>
          <Field label="Amount (USD)">
            <Input
              type="number"
              min={0}
              step="1"
              value={prizeDollars}
              onChange={(e) => setPrizeDollars(e.target.value)}
              placeholder="500"
            />
            <Hint>For your records + the winners strip. Optional.</Hint>
          </Field>
        </div>
      </Section>

      <Section title="Hero marquee">
        <Field label="Marquee text">
          <Input
            value={marqueeText}
            onChange={(e) => setMarqueeText(e.target.value)}
            placeholder="$500 for the best AI side-project this week"
          />
          <Hint>
            The scrolling banner shown on the homepage while this challenge is
            active. Keep it short — it&apos;s the one moving element on an
            otherwise-static page.
          </Hint>
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Button label">
            <Input
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Apply"
            />
          </Field>
          <Field label="Button link (optional)">
            <Input
              value={ctaHref}
              onChange={(e) => setCtaHref(e.target.value)}
              placeholder={`/challenges/${slug || "…"}`}
            />
            <Hint>Defaults to this challenge&apos;s apply page.</Hint>
          </Field>
        </div>
        {/* Live preview of the yellow bar. */}
        <div className="overflow-hidden rounded-md border border-on-spark/15">
          <div className="flex items-center gap-3 bg-spark px-4 py-2 text-on-spark">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">
              ⚡ Weekly Challenge
            </span>
            <span className="truncate text-[13px]">{marqueePreview}</span>
            <span className="ml-auto shrink-0 text-[13px] font-semibold underline decoration-on-spark/40 underline-offset-2">
              {ctaLabel || "Apply"} →
            </span>
          </div>
        </div>
      </Section>

      <Section title="Schedule">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Opens at (optional)">
            <Input
              type="datetime-local"
              value={opensAt}
              onChange={(e) => setOpensAt(e.target.value)}
            />
          </Field>
          <Field label="Closes at (optional)">
            <Input
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
            <Hint>After this, the apply form closes automatically.</Hint>
          </Field>
        </div>
      </Section>

      <Section title="Application questions">
        <ChallengeQuestionBuilder value={questions} onChange={setQuestions} />
      </Section>

      <Section title="Winners">
        <Toggle
          label="Publish winners publicly"
          description="When on, funded submissions you mark as public appear in the 'recently funded' strip on the site. Individual winners are opt-in per submission."
          checked={winnersPublished}
          onChange={setWinnersPublished}
        />
      </Section>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : initial?.id ? "Save challenge" : "Create challenge"}
        </Button>
        {saved && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-4 text-xs font-mono font-semibold uppercase tracking-[0.18em] text-spark-ink">
        {title}
      </h3>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
