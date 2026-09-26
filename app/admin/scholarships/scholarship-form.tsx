"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import {
  SCHOLARSHIP_KINDS,
  SCHOLARSHIP_KIND_LABELS,
  SCHOLARSHIP_KIND_BLURBS,
  AWARD_PERK_DEFS,
  describeAward,
  normalizePerks,
  normalizePercent,
  type AwardPerkKey,
} from "@/lib/scholarship-award";
import { saveScholarship } from "./actions";
// The seeds live in ./form-values, not here: the server pages *call* them, and
// a "use client" export is only ever a client reference on the server.
import type { ScholarshipFormValues } from "./form-values";

/** The form field that says whether a perk is ticked, and the one with its count. */
const PERK_FIELDS: Record<
  AwardPerkKey,
  { on: keyof ScholarshipFormValues; count: keyof ScholarshipFormValues | null }
> = {
  mentorCalls: { on: "mentorCallsOn", count: "mentorCalls" },
  feedbackCredits: { on: "feedbackCreditsOn", count: "feedbackCredits" },
  demoDayTickets: { on: "demoDayTicketsOn", count: "demoDayTickets" },
  aiBoost: { on: "aiBoost", count: null },
};

export function ScholarshipForm({ initial }: { initial: ScholarshipFormValues }) {
  const router = useRouter();
  const [v, setV] = useState<ScholarshipFormValues>(initial);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function set<K extends keyof ScholarshipFormValues>(
    k: K,
    value: ScholarshipFormValues[K],
  ) {
    setV((prev) => ({ ...prev, [k]: value }));
    setSaved(false);
  }

  function toggleStage(stage: string, on: boolean) {
    const next = on
      ? [...new Set([...v.eligibleStages, stage])]
      : v.eligibleStages.filter((s) => s !== stage);
    set("eligibleStages", next);
  }

  const usesPercent = v.money && v.awardPercent.trim() !== "";

  // The terms as the server will store them — same normalizers, same
  // ceilings — so the summary line below can't promise more than gets saved.
  const perks = normalizePerks({
    mentorCalls: v.mentorCallsOn ? v.mentorCalls : 0,
    feedbackCredits: v.feedbackCreditsOn ? v.feedbackCredits : 0,
    demoDayTickets: v.demoDayTicketsOn ? v.demoDayTickets : 0,
    aiBoost: v.aiBoost,
  });
  const dollars = Number(v.awardDollars);
  const previewTerms = {
    amountCents: v.money && Number.isFinite(dollars) ? Math.max(0, Math.floor(dollars * 100)) : 0,
    percent: v.money ? normalizePercent(v.awardPercent) : null,
    perks,
  };
  const worthSomething =
    previewTerms.percent !== null ||
    previewTerms.amountCents > 0 ||
    perks.mentorCalls > 0 ||
    perks.feedbackCredits > 0 ||
    perks.demoDayTickets > 0 ||
    perks.aiBoost;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        const res = await saveScholarship(v);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        if (!initial.id && res.data) {
          router.push(`/admin/scholarships/${res.data.id}`);
        }
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="s-name" required>
            Name *
          </Label>
          <Input
            id="s-name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Need-based grant"
          />
        </div>
        <div>
          <Label htmlFor="s-slug">URL slug</Label>
          <Input
            id="s-slug"
            value={v.slug}
            onChange={(e) => set("slug", e.target.value)}
            placeholder="Left blank, we make one from the name"
          />
          <p className="mt-1 text-xs text-ink-faint">
            /dashboard/scholarships/<strong>{v.slug || "…"}</strong>. Changing it
            breaks any link you've already sent out.
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor="s-kind">Kind</Label>
        <Select
          id="s-kind"
          value={v.kind}
          onChange={(e) => set("kind", e.target.value)}
        >
          {SCHOLARSHIP_KINDS.map((k) => (
            <option key={k} value={k}>
              {SCHOLARSHIP_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-ink-faint">
          {SCHOLARSHIP_KIND_BLURBS[v.kind as keyof typeof SCHOLARSHIP_KIND_BLURBS] ??
            ""}{" "}
          This is a label — what it actually pays out is set below, so a merit
          scholarship granting mentor calls is perfectly valid.
        </p>
      </div>

      <div>
        <Label htmlFor="s-tagline">Tagline</Label>
        <Input
          id="s-tagline"
          value={v.tagline}
          onChange={(e) => set("tagline", e.target.value)}
          placeholder="One line on the card."
        />
      </div>

      <div>
        <Label htmlFor="s-description">Description</Label>
        <Textarea
          id="s-description"
          rows={4}
          value={v.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What it's for, who it's for, and what you're looking for in an application."
        />
      </div>

      <div className="rounded-xl border border-line bg-wash p-4">
        <h3 className="mb-1 text-sm font-medium text-ink">What it's worth</h3>
        <p className="mb-4 text-xs text-ink-faint">
          Tick what this scholarship carries. Money and perks stack — or leave
          money off for a scholarship that&apos;s perks only.
        </p>

        {/* ---- The money half. */}
        <div
          className={`rounded-lg border px-3 py-2.5 transition ${
            v.money ? "border-phosphor/60 bg-phosphor/[0.06]" : "border-line"
          }`}
        >
          <label htmlFor="s-money" className="flex cursor-pointer items-start gap-3">
            <input
              id="s-money"
              type="checkbox"
              checked={v.money}
              onChange={(e) => set("money", e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-line"
            />
            <span className="min-w-0 flex-1">
              <span
                className={`block text-sm font-semibold ${
                  v.money ? "text-phosphor-ink" : "text-ink"
                }`}
              >
                Money off tuition
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                Comes off checkout for a student who hasn&apos;t paid; a partial
                refund you approve by hand for one who has.
              </span>
            </span>
          </label>
          {v.money && (
            <div className="mt-3 grid gap-4 pl-7 sm:grid-cols-2">
              <div>
                <Label htmlFor="s-dollars">Flat amount ($)</Label>
                <Input
                  id="s-dollars"
                  type="number"
                  min={0}
                  step="1"
                  value={v.awardDollars}
                  disabled={usesPercent}
                  onChange={(e) => set("awardDollars", e.target.value)}
                  placeholder="50"
                />
              </div>
              <div>
                <Label htmlFor="s-percent">…or a percentage</Label>
                <Input
                  id="s-percent"
                  type="number"
                  min={1}
                  max={100}
                  value={v.awardPercent}
                  onChange={(e) => set("awardPercent", e.target.value)}
                  placeholder="50"
                />
              </div>
              <p className="text-xs text-ink-faint sm:col-span-2">
                {usesPercent
                  ? "A percentage wins over the flat amount, and is resolved against what the student would actually be billed — after regional pricing, any sale, and a founder pass. So it stays half of tuition even when tuition changes."
                  : "A flat amount is taken off the price after every other discount, and is capped at what they actually owe. Set a percentage instead if you want it to track tuition."}
              </p>
            </div>
          )}
        </div>

        {/* ---- The perks (0074). A count perk asks how many the moment it's
            ticked. */}
        <Label className="mt-4">Perks</Label>
        <div className="space-y-2">
          {AWARD_PERK_DEFS.map((d) => {
            const fields = PERK_FIELDS[d.key];
            const on = v[fields.on] === true;
            const count = d.kind === "count" ? perks[d.key] : 0;
            const countBad = d.kind === "count" && on && count < 1;
            const inputId = `s-perk-${d.key}`;
            const countId = `${inputId}-count`;
            return (
              <div
                key={d.key}
                className={`rounded-lg border px-3 py-2.5 transition ${
                  on ? "border-phosphor/60 bg-phosphor/[0.06]" : "border-line"
                }`}
              >
                <label htmlFor={inputId} className="flex cursor-pointer items-start gap-3">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      set(fields.on, e.target.checked as ScholarshipFormValues[typeof fields.on])
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-line"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-sm font-semibold ${
                        on ? "text-phosphor-ink" : "text-ink"
                      }`}
                    >
                      {d.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-ink-faint">
                      {d.blurb}
                    </span>
                  </span>
                </label>
                {d.kind === "count" && on && fields.count && (
                  <div className="mt-2.5 pl-7">
                    <Label htmlFor={countId}>How many for this scholarship?</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Wrapped rather than sized on the Input: its base
                          classes carry w-full, which beats a width utility
                          passed alongside. */}
                      <div className="w-24">
                        <Input
                          id={countId}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={d.max}
                          step={1}
                          value={String(v[fields.count] ?? "")}
                          onChange={(e) =>
                            set(
                              fields.count as keyof ScholarshipFormValues,
                              e.target.value as ScholarshipFormValues[keyof ScholarshipFormValues],
                            )
                          }
                          error={countBad}
                          className="h-9"
                        />
                      </div>
                      <span className="text-xs text-ink-faint">
                        {countBad ? (
                          <span id={`${countId}-error`} className="text-red-700 dark:text-red-300">
                            Enter 1–{d.max}.
                          </span>
                        ) : (
                          `${count} ${d.unit}${count === 1 ? "" : "s"} per student · up to ${d.max}`
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* What the card and the award email will say — built from the same
            describeAward() they use, so this preview can't drift from them. */}
        <p className="mt-3 text-xs text-ink-faint">
          {worthSomething ? (
            <>
              Reads as:{" "}
              <span className="font-medium text-phosphor-ink">
                {describeAward(previewTerms)}
              </span>
            </>
          ) : (
            <span className="text-amber-600 dark:text-amber-300">
              Tick money off tuition, at least one perk, or both — a scholarship
              worth nothing can&apos;t be saved.
            </span>
          )}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="s-seats">Seats per cohort</Label>
          <Input
            id="s-seats"
            type="number"
            min={0}
            value={v.seats}
            onChange={(e) => set("seats", e.target.value)}
            placeholder="Unlimited"
            aria-describedby="s-seats-help"
          />
        </div>
        {/* No opens/closes dates: a scholarship has no window of its own. */}
        <p
          id="s-seats-help"
          className="self-end text-xs text-ink-faint sm:col-span-2"
        >
          Each student&apos;s window follows their cohort: accepted students
          until its enrollment deadline, enrolled students until it ends.
          Seats count separately in each cohort.
        </p>
      </div>

      <div>
        <Label>Who can apply</Label>
        <div className="mt-1 space-y-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={v.eligibleStages.includes("accepted")}
              onChange={(e) => toggleStage("accepted", e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Accepted, not yet paid —{" "}
            <span className="text-ink-soft">
              the award comes off their checkout
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={v.eligibleStages.includes("enrolled")}
              onChange={(e) => toggleStage("enrolled", e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Already enrolled —{" "}
            <span className="text-ink-soft">
              a money award becomes a refund you approve by hand
            </span>
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle
          label="Open"
          description="Off hides it from everyone who hasn't already applied."
          checked={v.enabled}
          onChange={(on) => set("enabled", on)}
        />
        <div>
          <Label htmlFor="s-sort">Sort order</Label>
          <Input
            id="s-sort"
            type="number"
            value={v.sortIndex}
            onChange={(e) => set("sortIndex", e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">Lower shows first.</p>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : initial.id
              ? "Save changes"
              : "Create scholarship"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </form>
  );
}
