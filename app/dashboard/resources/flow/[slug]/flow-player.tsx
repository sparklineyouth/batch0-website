"use client";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  type FlowAnswers,
  type StepConfig,
  type StepKind,
  type OutcomeBlock,
  firstStepKey,
  nextStepKeyByOrder,
  outcomeBlockMatches,
  renderTemplate,
  resolveAnswer,
  flaggedPhrases,
} from "@/lib/flows";
import { saveFlowProgress } from "../actions";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  CheckCircle,
  Download,
  RotateCcw,
  Sparkles,
} from "lucide-react";

export type CompiledStep = {
  step_key: string;
  title: string | null;
  kind: StepKind;
  config: StepConfig;
  sort_order: number;
  bodyHtml: string | null;
  blocks:
    | (OutcomeBlock & { bodyHtml: string })[]
    | null;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");
}

export function FlowPlayer({
  flowId,
  title,
  tagline,
  estMinutes,
  steps,
  initialAnswers,
  initialStep,
  initiallyCompleted,
}: {
  flowId: string;
  title: string;
  tagline: string | null;
  estMinutes: number | null;
  steps: CompiledStep[];
  initialAnswers: FlowAnswers;
  initialStep: string | null;
  initiallyCompleted: boolean;
}) {
  const ordered = useMemo(
    () => [...steps].sort((a, b) => a.sort_order - b.sort_order),
    [steps],
  );
  const byKey = useMemo(
    () => new Map(ordered.map((s) => [s.step_key, s])),
    [ordered],
  );
  const first = firstStepKey(ordered) as string;

  const initKey =
    initialStep && byKey.has(initialStep) ? initialStep : first;

  const [answers, setAnswers] = useState<FlowAnswers>(initialAnswers ?? {});
  const [currentKey, setCurrentKey] = useState<string>(initKey);
  const [history, setHistory] = useState<string[]>([]);
  const [completed, setCompleted] = useState(initiallyCompleted);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [, startSave] = useTransition();

  // Draft answers for the step being edited (inputs / checklist) — seeded
  // from saved answers so resuming mid-flow restores what was typed.
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const saved = (initialAnswers ?? {})[initKey];
    return byKey.get(initKey)?.kind === "input" &&
      saved &&
      typeof saved === "object" &&
      !Array.isArray(saved)
      ? { ...saved }
      : {};
  });
  const [checked, setChecked] = useState<string[]>(() => {
    const saved = (initialAnswers ?? {})[initKey];
    return byKey.get(initKey)?.kind === "checklist" && Array.isArray(saved)
      ? [...saved]
      : [];
  });
  const [touched, setTouched] = useState(false);

  const step = byKey.get(currentKey) ?? ordered[0];
  const position = ordered.findIndex((s) => s.step_key === step.step_key);
  const pct = Math.round(((position + 1) / ordered.length) * 100);

  function persist(next: FlowAnswers, key: string, done: boolean, restart = false) {
    startSave(() => {
      saveFlowProgress({
        flowId,
        answers: next,
        currentStep: key,
        completed: done,
        restart,
      }).catch(() => {
        /* best-effort; the flow keeps working locally */
      });
    });
  }

  function loadDraftFor(key: string, source: FlowAnswers) {
    const target = byKey.get(key);
    const saved = source[key];
    if (target?.kind === "input") {
      setDraft(
        saved && typeof saved === "object" && !Array.isArray(saved)
          ? { ...saved }
          : {},
      );
    } else {
      setDraft({});
    }
    setChecked(target?.kind === "checklist" && Array.isArray(saved) ? [...saved] : []);
    setTouched(false);
  }

  function goTo(key: string | null, nextAnswers: FlowAnswers) {
    if (!key || !byKey.has(key)) return;
    setHistory((h) => [...h, step.step_key]);
    setAnswers(nextAnswers);
    setCurrentKey(key);
    loadDraftFor(key, nextAnswers);
    const isDone = byKey.get(key)?.kind === "outcome";
    if (isDone) setCompleted(true);
    persist(nextAnswers, key, isDone || completed);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function defaultNext(): string | null {
    return step.config.next ?? nextStepKeyByOrder(ordered, step.step_key);
  }

  function goBack() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setCurrentKey(prev);
    loadDraftFor(prev, answers);
  }

  function restart() {
    setAnswers({});
    setHistory([]);
    setCompleted(false);
    setCurrentKey(first);
    loadDraftFor(first, {});
    setConfirmRestart(false);
    persist({}, first, false, true);
  }

  // ---- per-kind interactions -------------------------------------------

  function pickOption(value: string) {
    const opt = step.config.options?.find((o) => o.value === value);
    if (!opt) return;
    const next = { ...answers, [step.step_key]: value };
    goTo(opt.next ?? nextStepKeyByOrder(ordered, step.step_key), next);
  }

  function submitInput() {
    setTouched(true);
    const fields = step.config.fields ?? [];
    const missing = fields.some(
      (f) => f.required !== false && !(draft[f.key] ?? "").trim(),
    );
    if (missing) return;
    const clean: Record<string, string> = {};
    for (const f of fields) clean[f.key] = (draft[f.key] ?? "").trim();
    goTo(defaultNext(), { ...answers, [step.step_key]: clean });
  }

  function submitChecklist() {
    setTouched(true);
    const items = step.config.items ?? [];
    if (step.config.requireAll && checked.length < items.length) return;
    goTo(defaultNext(), { ...answers, [step.step_key]: checked });
  }

  // ---- download summary -------------------------------------------------

  function downloadSummary() {
    const lines: string[] = [`# ${title} — summary`, ""];
    for (const s of ordered) {
      if (s.kind === "outcome" || answers[s.step_key] == null) continue;
      lines.push(`## ${s.title ?? s.step_key}`);
      if (s.kind === "input") {
        for (const f of s.config.fields ?? []) {
          const v = resolveAnswer(ordered, answers, s.step_key, f.key);
          if (v) lines.push(`**${f.label}**`, v, "");
        }
      } else {
        const v = resolveAnswer(ordered, answers, s.step_key);
        if (v) lines.push(v, "");
      }
    }
    const outcome = ordered.find((s) => s.kind === "outcome" && s.step_key === step.step_key) ?? step;
    for (const b of outcome.blocks ?? []) {
      if (!outcomeBlockMatches(b, answers)) continue;
      if (b.title) lines.push(`## ${b.title}`);
      lines.push(renderTemplate(b.body, ordered, answers), "");
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-summary.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- render -------------------------------------------------------------

  const lintWarnings =
    step.kind === "input"
      ? (step.config.fields ?? []).flatMap((f) =>
          flaggedPhrases(draft[f.key] ?? "", f.flags).map(
            (p) => ({ field: f.label, phrase: p }),
          ),
        )
      : [];

  return (
    <div className="mt-4">
      <div className="border-b border-line pb-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          Before One{estMinutes ? ` · ~${estMinutes} min` : ""}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-[-0.02em] text-ink">
          {title}
        </h1>
        {tagline && <p className="mt-1 text-sm text-ink-soft">{tagline}</p>}
        <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-wash">
          <div
            className="h-full rounded-full bg-phosphor transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-8">
        {step.title && (
          <h2 className="text-xl font-semibold text-ink">{step.title}</h2>
        )}
        {step.bodyHtml && (
          <div
            className="blog-prose mt-3"
            dangerouslySetInnerHTML={{ __html: step.bodyHtml }}
          />
        )}

        {step.kind === "choice" && (
          <div className="mt-6 space-y-2">
            {(step.config.options ?? []).map((o) => {
              const selected = answers[step.step_key] === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => pickOption(o.value)}
                  className={`press block w-full rounded-xl border px-4 py-3 text-left ${
                    selected
                      ? "border-phosphor bg-phosphor/[0.08]"
                      : "border-line bg-paper hover:border-ink/30 hover:bg-wash"
                  }`}
                >
                  <span className="block text-sm font-medium text-ink">
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="mt-0.5 block text-xs text-ink-soft">
                      {o.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {step.kind === "input" && (
          <div className="mt-6 space-y-4">
            {(step.config.fields ?? []).map((f) => {
              const val = draft[f.key] ?? "";
              const missing =
                touched && f.required !== false && !val.trim();
              return (
                <div key={f.key}>
                  <Label htmlFor={`fld-${f.key}`}>{f.label}</Label>
                  {f.multiline ? (
                    <Textarea
                      id={`fld-${f.key}`}
                      rows={4}
                      value={val}
                      placeholder={f.placeholder}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                      }
                    />
                  ) : (
                    <Input
                      id={`fld-${f.key}`}
                      value={val}
                      placeholder={f.placeholder}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                      }
                    />
                  )}
                  {missing && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      This one's required.
                    </p>
                  )}
                </div>
              );
            })}
            {lintWarnings.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Garbage-phrase alert:{" "}
                  {lintWarnings
                    .map((w) => `"${w.phrase}"`)
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(", ")}{" "}
                  — be more specific. You can continue, but vague words hide
                  weak thinking.
                </p>
              </div>
            )}
          </div>
        )}

        {step.kind === "checklist" && (
          <div className="mt-6 space-y-2">
            {(step.config.items ?? []).map((it) => {
              const on = checked.includes(it.key);
              return (
                <label
                  key={it.key}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-paper px-4 py-3 hover:bg-wash"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setChecked((c) =>
                        on ? c.filter((k) => k !== it.key) : [...c, it.key],
                      )
                    }
                    className="mt-0.5 h-4 w-4 accent-[#ffbb00]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      {it.label}
                    </span>
                    {it.hint && (
                      <span className="mt-0.5 block text-xs text-ink-faint">
                        {it.hint}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {touched &&
              step.config.requireAll &&
              checked.length < (step.config.items?.length ?? 0) && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Tick everything off before continuing — each item matters.
                </p>
              )}
          </div>
        )}

        {step.kind === "outcome" && (
          <div className="mt-6 space-y-5">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle className="h-3.5 w-3.5" /> Completed
            </p>
            {(step.blocks ?? [])
              .filter((b) => outcomeBlockMatches(b, answers))
              .map((b, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-line bg-wash p-5"
                >
                  {b.title && (
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                      <Sparkles className="h-3.5 w-3.5" /> {b.title}
                    </p>
                  )}
                  <div
                    className="blog-prose mt-2"
                    dangerouslySetInnerHTML={{
                      __html: renderTemplate(
                        b.bodyHtml,
                        ordered,
                        answers,
                        esc,
                      ),
                    }}
                  />
                </div>
              ))}
            <div className="flex flex-wrap gap-2">
              <Button onClick={downloadSummary}>
                <Download className="h-4 w-4" /> Download summary
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRestart(true)}>
                <RotateCcw className="h-4 w-4" /> Start over
              </Button>
            </div>
          </div>
        )}
      </div>

      {step.kind !== "outcome" && (
        <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
          <Button
            variant="ghost"
            onClick={goBack}
            disabled={history.length === 0}
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step.kind === "content" && (
            <Button onClick={() => goTo(defaultNext(), answers)}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          )}
          {step.kind === "input" && (
            <Button onClick={submitInput}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          )}
          {step.kind === "checklist" && (
            <Button onClick={submitChecklist}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          )}
          {step.kind === "choice" && (
            <p className="text-xs text-ink-faint">Pick one to continue</p>
          )}
        </div>
      )}
      {step.kind === "outcome" && (
        <div className="mt-8 border-t border-line pt-5">
          <Button variant="ghost" onClick={goBack} disabled={history.length === 0}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRestart}
        title="Start this flow over?"
        description={
          <p>Your saved answers for this flow will be cleared.</p>
        }
        confirmLabel="Start over"
        destructive
        pending={false}
        onConfirm={restart}
        onCancel={() => setConfirmRestart(false)}
      />
    </div>
  );
}
