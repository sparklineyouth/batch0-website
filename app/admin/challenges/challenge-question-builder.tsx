"use client";
import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  Trash2,
  X,
  Type,
  AlignLeft,
  Link2,
  Video,
  Paperclip,
  CircleDot,
  CheckSquare,
  Hash,
  Gauge,
  Users,
  SquareCheck,
  Heading,
} from "lucide-react";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import {
  CHALLENGE_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  QUESTION_PRESETS,
  FILE_KIND_LABELS,
  blankQuestion,
  newQuestionId,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MAX_FILES_PER_QUESTION,
  MAX_TEAM,
  LONG_TEXT_MAX,
  SHORT_TEXT_MAX,
  type ChallengeQuestion,
  type ChallengeQuestionType,
  type FileKind,
} from "@/lib/challenges-shared";

export type DraftQuestion = ChallengeQuestion;

const TYPE_ICON: Record<ChallengeQuestionType, React.ComponentType<{ className?: string }>> = {
  short_text: Type,
  long_text: AlignLeft,
  url: Link2,
  video: Video,
  file: Paperclip,
  select: CircleDot,
  multi_select: CheckSquare,
  number: Hash,
  scale: Gauge,
  team: Users,
  checkbox: SquareCheck,
  section: Heading,
};

/**
 * The submission-form builder. Every question is a collapsible card; the
 * quick-add row covers the fields almost every hackathon wants (name, pitch,
 * demo, repo, video, screenshots, team, rules) so building a form is a few
 * clicks, not a few minutes.
 */
export function ChallengeQuestionBuilder({
  value,
  onChange,
}: {
  value: DraftQuestion[];
  onChange: (next: DraftQuestion[]) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [customType, setCustomType] = useState<ChallengeQuestionType>("short_text");
  const full = value.length >= MAX_QUESTIONS;

  function update(i: number, patch: Partial<DraftQuestion>) {
    onChange(value.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function duplicate(i: number) {
    if (full) return;
    const copy = { ...value[i], id: newQuestionId(), options: [...value[i].options], label: `${value[i].label} (copy)` };
    const next = value.slice();
    next.splice(i + 1, 0, copy);
    onChange(next);
    setOpenId(copy.id);
  }
  function add(q: DraftQuestion, open = false) {
    if (full) return;
    onChange([...value, q]);
    if (open) setOpenId(q.id);
  }
  function setType(i: number, type: ChallengeQuestionType) {
    const patch: Partial<DraftQuestion> = { type };
    if ((type === "select" || type === "multi_select") && value[i].options.length < 2) {
      patch.options = ["", ""];
    }
    if (type === "section") patch.required = false;
    update(i, patch);
  }

  const usedPresets = new Set(
    value.map((q) => QUESTION_PRESETS.find((p) => p.make().label === q.label)?.key).filter(Boolean),
  );

  return (
    <div className="space-y-3">
      {/* Quick add */}
      <div className="rounded-xl border border-line bg-wash p-3">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">Quick add</p>
        <div className="flex flex-wrap gap-1.5">
          {QUESTION_PRESETS.map((p) => {
            const used = usedPresets.has(p.key) && p.key !== "section";
            return (
              <button
                key={p.key}
                type="button"
                disabled={full || used}
                onClick={() => add(p.make())}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 text-[12px] text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {used ? "✓" : <Plus className="h-3 w-3" />} {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {value.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-ink-faint">
          No questions yet. Use quick add above, or add a custom one below.
        </p>
      )}

      {value.map((q, i) => {
        const Icon = TYPE_ICON[q.type];
        const open = openId === q.id || !q.label.trim();
        return (
          <section key={q.id} className={`rounded-xl border bg-paper ${open ? "border-ink/25" : "border-line"}`}>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : q.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                aria-expanded={open}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-wash text-ink-soft">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[14px] ${q.type === "section" ? "font-display text-[17px]" : "font-medium"} text-ink`}>
                    {q.label || <span className="text-ink-faint">Untitled question</span>}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-faint">
                    {QUESTION_TYPE_LABELS[q.type]}
                    {q.required ? " · required" : ""}
                    {(q.type === "select" || q.type === "multi_select") && q.options.filter(Boolean).length
                      ? ` · ${q.options.filter(Boolean).length} choices`
                      : ""}
                    {q.type === "file" ? ` · up to ${q.maxFiles}` : ""}
                    {q.maxLength ? ` · ${q.maxLength} chars` : ""}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ChevronUp className="h-4 w-4" />
                </IconBtn>
                <IconBtn label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                  <ChevronDown className="h-4 w-4" />
                </IconBtn>
                <IconBtn label="Duplicate" disabled={full} onClick={() => duplicate(i)}>
                  <Copy className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Remove question" onClick={() => remove(i)} danger>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </div>

            {open && (
              <div className="space-y-4 border-t border-line px-4 pb-4 pt-4">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                  <div>
                    <Label htmlFor={`${q.id}-label`}>{q.type === "section" ? "Heading" : q.type === "checkbox" ? "Statement they tick" : "Question"}</Label>
                    <Input
                      id={`${q.id}-label`}
                      value={q.label}
                      autoFocus={!q.label}
                      onChange={(e) => update(i, { label: e.target.value })}
                      placeholder={q.type === "section" ? "About your project" : "e.g. What did you build?"}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`${q.id}-type`}>Type</Label>
                    <Select id={`${q.id}-type`} value={q.type} onChange={(e) => setType(i, e.target.value as ChallengeQuestionType)}>
                      {CHALLENGE_QUESTION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {QUESTION_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div>
                  <Label htmlFor={`${q.id}-help`}>{q.type === "section" ? "Intro text" : "Help text"}</Label>
                  <Textarea
                    id={`${q.id}-help`}
                    rows={2}
                    value={q.help}
                    onChange={(e) => update(i, { help: e.target.value })}
                    placeholder="Optional guidance shown under the question."
                  />
                </div>

                {["short_text", "long_text", "url", "video", "number"].includes(q.type) && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`${q.id}-ph`}>Placeholder</Label>
                      <Input
                        id={`${q.id}-ph`}
                        value={q.placeholder}
                        onChange={(e) => update(i, { placeholder: e.target.value })}
                        placeholder={q.type === "url" ? "https://github.com/…" : "Optional"}
                      />
                    </div>
                    {(q.type === "short_text" || q.type === "long_text") && (
                      <div>
                        <Label htmlFor={`${q.id}-max`}>Character limit</Label>
                        <Input
                          id={`${q.id}-max`}
                          type="number"
                          min={1}
                          max={q.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX}
                          value={q.maxLength ?? ""}
                          onChange={(e) =>
                            update(i, { maxLength: e.target.value === "" ? null : Number(e.target.value) })
                          }
                          placeholder={`No limit (max ${(q.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX).toLocaleString()})`}
                        />
                      </div>
                    )}
                  </div>
                )}

                {(q.type === "select" || q.type === "multi_select") && (
                  <OptionsEditor
                    options={q.options}
                    onChange={(options) => update(i, { options })}
                    multi={q.type === "multi_select"}
                  />
                )}

                {q.type === "file" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`${q.id}-fk`}>Accepts</Label>
                      <Select id={`${q.id}-fk`} value={q.fileKind} onChange={(e) => update(i, { fileKind: e.target.value as FileKind })}>
                        {(Object.keys(FILE_KIND_LABELS) as FileKind[]).map((k) => (
                          <option key={k} value={k}>
                            {FILE_KIND_LABELS[k]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor={`${q.id}-mf`}>Max files</Label>
                      <Input
                        id={`${q.id}-mf`}
                        type="number"
                        min={1}
                        max={MAX_FILES_PER_QUESTION}
                        value={q.maxFiles}
                        onChange={(e) => update(i, { maxFiles: Number(e.target.value) || 1 })}
                      />
                    </div>
                  </div>
                )}

                {q.type === "scale" && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <Label htmlFor={`${q.id}-sm`}>Scale 1 to</Label>
                      <Input id={`${q.id}-sm`} type="number" min={3} max={10} value={q.scaleMax} onChange={(e) => update(i, { scaleMax: Number(e.target.value) || 5 })} />
                    </div>
                    <div>
                      <Label htmlFor={`${q.id}-sl`}>Low label</Label>
                      <Input id={`${q.id}-sl`} value={q.scaleMinLabel} onChange={(e) => update(i, { scaleMinLabel: e.target.value })} placeholder="Not at all" />
                    </div>
                    <div>
                      <Label htmlFor={`${q.id}-sh`}>High label</Label>
                      <Input id={`${q.id}-sh`} value={q.scaleMaxLabel} onChange={(e) => update(i, { scaleMaxLabel: e.target.value })} placeholder="Extremely" />
                    </div>
                  </div>
                )}

                {q.type === "team" && (
                  <div className="max-w-[12rem]">
                    <Label htmlFor={`${q.id}-mt`}>Max teammates</Label>
                    <Input id={`${q.id}-mt`} type="number" min={1} max={MAX_TEAM} value={q.maxTeam} onChange={(e) => update(i, { maxTeam: Number(e.target.value) || 1 })} />
                  </div>
                )}

                {q.type !== "section" && (
                  <Toggle
                    label="Required"
                    description={q.type === "checkbox" ? "They must tick it to submit." : "They must answer this to submit. Drafts can still be saved without it."}
                    checked={q.required}
                    onChange={(v) => update(i, { required: v })}
                  />
                )}
              </div>
            )}
          </section>
        );
      })}

      {!full ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Select
            aria-label="Custom question type"
            value={customType}
            onChange={(e) => setCustomType(e.target.value as ChallengeQuestionType)}
            className="!w-auto"
          >
            {CHALLENGE_QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <button
            type="button"
            onClick={() =>
              add(
                blankQuestion({
                  type: customType,
                  options: customType === "select" || customType === "multi_select" ? ["", ""] : [],
                }),
                true,
              )
            }
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-line bg-paper px-3 text-sm font-medium text-ink hover:border-ink/30"
          >
            <Plus className="h-4 w-4" /> Add custom question
          </button>
        </div>
      ) : (
        <p className="text-xs text-ink-faint">Maximum of {MAX_QUESTIONS} questions reached.</p>
      )}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
  multi,
}: {
  options: string[];
  onChange: (o: string[]) => void;
  multi: boolean;
}) {
  const [bulk, setBulk] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Choices</Label>
        <button type="button" onClick={() => setBulk((b) => !b)} className="text-[12px] text-phosphor-ink hover:underline">
          {bulk ? "Edit one by one" : "Paste a list"}
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-faint">
        At least two. {multi ? "Entrants can pick several." : "Entrants pick one."}
      </p>
      {bulk ? (
        <Textarea
          rows={5}
          value={options.join("\n")}
          onChange={(e) => onChange(e.target.value.split("\n").slice(0, MAX_OPTIONS))}
          placeholder={"One choice per line"}
        />
      ) : (
        <div className="space-y-2">
          {options.map((opt, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <Input
                aria-label={`Choice ${oi + 1}`}
                value={opt}
                onChange={(e) => onChange(options.map((o, j) => (j === oi ? e.target.value : o)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (options.length < MAX_OPTIONS) onChange([...options, ""]);
                  }
                }}
                placeholder={`Choice ${oi + 1}`}
              />
              <IconBtn label={`Remove choice ${oi + 1}`} disabled={options.length <= 2} onClick={() => onChange(options.filter((_, j) => j !== oi))} danger>
                <X className="h-4 w-4" />
              </IconBtn>
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button type="button" onClick={() => onChange([...options, ""])} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-phosphor-ink hover:underline">
              <Plus className="h-3 w-3" /> Add choice
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function IconBtn({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? "hover:!text-red-500" : ""
      }`}
    >
      {children}
    </button>
  );
}
