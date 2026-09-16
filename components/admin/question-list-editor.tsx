"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  hasOptions,
  uniqueQuestionId,
  blankQuestion,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type CustomQuestion,
  type QuestionType,
} from "@/lib/question-schema";

// ---------------------------------------------------------------------------
// The editor for a list of admin-authored questions.
//
// Used in three places — the extra questions on /apply, the shared scholarship
// block on /apply, and each scholarship's own questions — because all three
// are the same thing: an ordered list of CustomQuestion answered into a jsonb
// blob. One component means one notion of what "required" looks like and one
// place to fix a rendering bug.
//
// It is a controlled component: the parent owns the array and the save button.
// That's what lets the /apply page save built-ins and custom questions in a
// single atomic action rather than two that can half-succeed.
// ---------------------------------------------------------------------------

export function QuestionListEditor({
  questions,
  onChange,
  /** Ids that already exist elsewhere on the same form — kept unique against them. */
  reservedIds = [],
  emptyHint = "No extra questions yet.",
  /**
   * Freeze the rows while a save is in flight.
   *
   * Not cosmetic. On success the parent adopts the list the action returns, so
   * that the id the database assigned to a new question is the id the editor
   * holds from then on. Anything typed between the click and the response is
   * not in that list and is discarded by the adoption — the admin would watch
   * their words revert under a green "Saved." Freezing removes the window
   * instead of trying to merge across it, which is the only option that can't
   * end with two keys for one question.
   */
  disabled = false,
}: {
  questions: CustomQuestion[];
  onChange: (next: CustomQuestion[]) => void;
  reservedIds?: string[];
  emptyHint?: string;
  disabled?: boolean;
}) {
  // Scopes the document-level listener below to this editor's own rows: two
  // instances share the page on /admin/application-questions.
  const rootRef = React.useRef<HTMLFieldSetElement>(null);

  function patch(index: number, next: Partial<CustomQuestion>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...next } : q)));
  }

  /**
   * Derive the jsonb key from the label, but ONLY while the question is new.
   *
   * Once an id exists it is frozen: it is the key every answer already
   * collected is filed under, so renaming the label of a live question must
   * not orphan its answers. This is the single most consequential rule in the
   * editor and the reason the id is shown on screen rather than hidden.
   *
   * Deliberately on blur and not on each keystroke. Deriving it as the admin
   * typed froze the id at whatever the first character slugified to — "What's
   * the biggest risk?" was filed under `w` — because the very next keystroke
   * saw a non-empty id and took the frozen branch. Blur means the label is
   * whole by the time we look at it.
   *
   * Not the guarantee, though: macOS Safari and Firefox don't focus a <button>
   * on click, so clicking Save right after typing fires no blur at all, and
   * Enter inside the /apply form submits without one either. Two things cover
   * that. The effect below commits on pointerdown, which fires whether or not
   * the button takes focus. And every parent's save action fills a still-blank
   * id (validateQuestionList) and RETURNS the list it stored for the parent to
   * adopt, so even a save that leaves here with `id: ""` ends with the client
   * holding the key the database now has — which is what stops the next label
   * edit from deriving a second key and orphaning the answers under the first.
   * What blur buys on top is the <code> above showing the real key while the
   * wording is still editable.
   */
  function commitId(index: number) {
    const q = questions[index];
    if (q.id || !q.label.trim()) return;
    const taken = [
      ...reservedIds,
      ...questions.filter((_, i) => i !== index).map((x) => x.id),
    ].filter(Boolean);
    const id = uniqueQuestionId(q.label, taken);
    if (id) patch(index, { id });
  }

  // Registered once, so it has to reach the CURRENT commitId rather than the
  // one closed over by the render that installed it.
  const commitIdRef = React.useRef(commitId);
  React.useEffect(() => {
    commitIdRef.current = commitId;
  });

  /**
   * Commit a blank id when the pointer goes down somewhere else.
   *
   * The blur above is the ordinary path; this is the one that survives a
   * browser that never fires it. macOS Safari and Firefox don't make a
   * <button> mouse-focusable, so clicking Save moves no focus and blurs no
   * input — pointerdown fires regardless, in the capture phase, before the
   * click handler that reads the list.
   *
   * On the document rather than on this editor's own container because the
   * Save button belongs to the parent and sits outside it. Scoped back down by
   * only ever committing the row whose own label input is focused: exactly the
   * row blur would have committed, and nothing else. A pointer landing
   * somewhere is no evidence that some other row's half-typed label is
   * finished, and an id derived from half a label is permanent.
   */
  React.useEffect(() => {
    function settleFocusedLabel(e: PointerEvent) {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || !active || !root.contains(active)) return;
      const attr = active.getAttribute("data-question-label");
      if (attr === null) return;
      const index = Number(attr);
      if (!Number.isInteger(index)) return;
      // A pointer landing inside the input being typed in — placing the
      // caret, selecting a word — is not the label settling.
      if (e.target instanceof Node && active.contains(e.target)) return;
      commitIdRef.current(index);
    }
    document.addEventListener("pointerdown", settleFocusedLabel, true);
    return () =>
      document.removeEventListener("pointerdown", settleFocusedLabel, true);
  }, []);

  function setType(index: number, type: QuestionType) {
    const nowHasOptions = hasOptions(type);
    onChange(
      questions.map((x, i) =>
        i === index
          ? {
              ...x,
              type,
              // Switching INTO a choice type seeds two blank options so the
              // validator's "needs at least two" doesn't fire on a question
              // the admin has only just started. Switching OUT clears them,
              // because options on a text field are a validation error.
              options: nowHasOptions
                ? x.options.length >= 2
                  ? x.options
                  : blankQuestion(type).options
                : [],
            }
          : x,
      ),
    );
  }

  /**
   * Rename an option. The stored VALUE is deliberately untouched — it is what
   * every answer already collected holds, so a label edit must never rewrite
   * it. That's also why the value is shown beside the input rather than hidden.
   */
  function setOption(index: number, optIndex: number, label: string) {
    const q = questions[index];
    patch(index, {
      options: q.options.map((o, i) => (i === optIndex ? { ...o, label } : o)),
    });
  }

  function addOption(index: number) {
    const q = questions[index];
    if (q.options.length >= MAX_OPTIONS) return;
    const used = new Set(q.options.map((o) => o.value));
    let n = q.options.length + 1;
    while (used.has(`option_${n}`)) n += 1;
    patch(index, { options: [...q.options, { value: `option_${n}`, label: "" }] });
  }

  function removeOption(index: number, optIndex: number) {
    const q = questions[index];
    patch(index, { options: q.options.filter((_, i) => i !== optIndex) });
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function addQuestion() {
    if (questions.length >= MAX_QUESTIONS) return;
    onChange([...questions, blankQuestion("text")]);
  }

  function deleteQuestion(index: number) {
    onChange(questions.filter((_, i) => i !== index));
  }

  return (
    // A <fieldset disabled> rather than a `disabled` on each control: the
    // attribute propagates to every form element inside it by spec, so an
    // input added here later cannot quietly miss the freeze. Preflight already
    // strips a fieldset's default margin, padding and border, so it lays out
    // as the plain block this was before; min-w-0 undoes the one behaviour it
    // does bring of its own, a min-inline-size that refuses to shrink.
    <fieldset
      ref={rootRef}
      disabled={disabled}
      aria-busy={disabled}
      className="min-w-0 space-y-4"
    >
      {questions.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-soft">
          {emptyHint}
        </p>
      )}

      {/* Keyed by position, never by q.id: the id is data this editor itself
          fills in, and a key that changes identity part-way through an edit
          remounts the row and throws away the focused input. Position is safe
          here because the row holds no state of its own — every value below
          reads out of questions[i]. */}
      {questions.map((q, i) => (
        <section key={i} className="rounded-xl border border-line bg-wash p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <code className="text-xs font-medium text-ink-soft">
              {q.id || <span className="italic">id set from the label</span>}
            </code>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move down"
                disabled={i === questions.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch(i, { hidden: !q.hidden, required: false })}
              >
                {q.hidden ? "Show" : "Hide"}
              </Button>
              <Button size="sm" variant="danger" onClick={() => deleteQuestion(i)}>
                Delete
              </Button>
            </div>
          </div>

          {q.hidden && (
            <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-300">
              Hidden — not shown on the form. Answers already collected are kept.
            </p>
          )}

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[2fr,1fr]">
              <div>
                <Label htmlFor={`q-${i}-label`}>Question</Label>
                <Input
                  id={`q-${i}-label`}
                  // Read back off document.activeElement by the pointerdown
                  // listener above: which row's label is being typed in.
                  data-question-label={i}
                  value={q.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  onBlur={() => commitId(i)}
                  placeholder="What's the biggest risk to your project?"
                />
              </div>
              <div>
                <Label htmlFor={`q-${i}-type`}>Answer type</Label>
                <Select
                  id={`q-${i}-type`}
                  value={q.type}
                  onChange={(e) => setType(i, e.target.value as QuestionType)}
                >
                  {QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {QUESTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor={`q-${i}-help`}>Help text</Label>
              <Textarea
                id={`q-${i}-help`}
                rows={2}
                value={q.help}
                onChange={(e) => patch(i, { help: e.target.value })}
                placeholder="Optional. Shown under the question."
              />
            </div>

            {!hasOptions(q.type) && q.type !== "checkbox" && (
              <div>
                <Label htmlFor={`q-${i}-ph`}>Placeholder</Label>
                <Input
                  id={`q-${i}-ph`}
                  value={q.placeholder}
                  onChange={(e) => patch(i, { placeholder: e.target.value })}
                  placeholder="Optional."
                />
              </div>
            )}

            {hasOptions(q.type) && (
              <div>
                <Label>Options</Label>
                <div className="space-y-2">
                  {q.options.map((opt, oi) => (
                    <div key={opt.value} className="flex items-center gap-2">
                      <code className="w-20 shrink-0 truncate text-[11px] text-ink-faint">
                        {opt.value}
                      </code>
                      <Input
                        aria-label={`Option ${oi + 1} label`}
                        value={opt.label}
                        onChange={(e) => setOption(i, oi, e.target.value)}
                        placeholder={`Option ${oi + 1}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove option ${oi + 1}`}
                        disabled={q.options.length <= 2}
                        onClick={() => removeOption(i, oi)}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  disabled={q.options.length >= MAX_OPTIONS}
                  onClick={() => addOption(i)}
                >
                  + Add option
                </Button>
                <p className="mt-2 text-xs text-ink-faint">
                  The code on the left is what gets stored. It stays put when you
                  rename an option, so existing answers keep their meaning.
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={q.required}
                disabled={q.hidden}
                onChange={(e) => patch(i, { required: e.target.checked })}
                className="h-4 w-4 rounded border-line"
              />
              Required
            </label>
          </div>
        </section>
      ))}

      <Button
        variant="secondary"
        size="sm"
        disabled={questions.length >= MAX_QUESTIONS}
        onClick={addQuestion}
      >
        + Add question
      </Button>
      {questions.length >= MAX_QUESTIONS && (
        <p className="text-xs text-ink-faint">
          That's the maximum of {MAX_QUESTIONS} questions.
        </p>
      )}
    </fieldset>
  );
}
