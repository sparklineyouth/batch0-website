"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import {
  FLOW_STAGES,
  STEP_KINDS,
  slugify,
  type FlowMeta,
  type FlowStepData,
  type StepKind,
  type ChoiceOption,
  type InputField,
  type ChecklistItem,
  type OutcomeBlock,
} from "@/lib/flows";
import { saveFlow, deleteFlow } from "./actions";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Plus,
  Trash2,
  X,
} from "lucide-react";

// Local step shape: a stable uid keeps React keys sane while the admin
// renames step_keys.
type BuilderStep = FlowStepData & { _uid: string };

let uidCounter = 0;
const nextUid = () => `u${++uidCounter}`;

function toBuilderSteps(steps: FlowStepData[]): BuilderStep[] {
  return steps
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({ ...s, config: s.config ?? {}, _uid: nextUid() }));
}

function newStep(kind: StepKind, index: number): BuilderStep {
  const base: BuilderStep = {
    _uid: nextUid(),
    step_key: `${kind}-${index + 1}`,
    title: "",
    kind,
    body: "",
    config: {},
    sort_order: index,
  };
  if (kind === "choice") {
    base.config.options = [{ value: "option-1", label: "Option 1" }];
  }
  if (kind === "input") {
    base.config.fields = [{ key: "answer", label: "Your answer", multiline: true }];
  }
  if (kind === "checklist") {
    base.config.items = [{ key: "item-1", label: "First item" }];
  }
  if (kind === "outcome") {
    base.config.blocks = [{ body: "You made it. Here's what to do next." }];
  }
  return base;
}

export function FlowBuilder({
  initial,
  initialSteps,
  cohorts,
}: {
  initial: FlowMeta;
  initialSteps: FlowStepData[];
  cohorts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [meta, setMeta] = useState<FlowMeta>(initial);
  const [steps, setSteps] = useState<BuilderStep[]>(() =>
    initialSteps.length
      ? toBuilderSteps(initialSteps)
      : [newStep("content", 0), newStep("outcome", 1)],
  );
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const step = steps[Math.min(selected, steps.length - 1)];

  function setMetaField<K extends keyof FlowMeta>(k: K, v: FlowMeta[K]) {
    setMeta((m) => ({ ...m, [k]: v }));
  }

  function patchStep(uid: string, patch: Partial<BuilderStep>) {
    setSteps((all) =>
      all.map((s) => (s._uid === uid ? { ...s, ...patch } : s)),
    );
  }

  function patchConfig(uid: string, patch: Partial<BuilderStep["config"]>) {
    setSteps((all) =>
      all.map((s) =>
        s._uid === uid ? { ...s, config: { ...s.config, ...patch } } : s,
      ),
    );
  }

  function addStep(kind: StepKind) {
    setSteps((all) => {
      const s = newStep(kind, all.length);
      setSelected(all.length);
      return [...all, s];
    });
  }

  function removeStep(uid: string) {
    setSteps((all) => {
      const next = all.filter((s) => s._uid !== uid);
      setSelected((i) => Math.max(0, Math.min(i, next.length - 1)));
      return next;
    });
  }

  function move(uid: string, dir: -1 | 1) {
    setSteps((all) => {
      const i = all.findIndex((s) => s._uid === uid);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j], next[i]];
      setSelected(j);
      return next;
    });
  }

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        const id = await saveFlow({
          flow: { ...meta, slug: meta.slug || slugify(meta.title) },
          steps: steps.map(({ _uid, ...s }, i) => ({ ...s, sort_order: i })),
        });
        if (!meta.id) {
          router.replace(`/admin/flows/${id}`);
        }
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function onDelete() {
    if (!meta.id) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteFlow(meta.id!);
        router.push("/admin/flows");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
        setConfirmDelete(false);
      }
    });
  }

  const stepKeys = steps.map((s) => s.step_key);
  const choiceSteps = steps.filter((s) => s.kind === "choice");

  return (
    <div className="space-y-6">
      {/* ---- flow meta ---- */}
      <div className="rounded-xl border border-line bg-paper p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="f-title">Title</Label>
            <Input
              id="f-title"
              value={meta.title}
              onChange={(e) => setMetaField("title", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="f-slug">Slug</Label>
            <Input
              id="f-slug"
              value={meta.slug}
              placeholder={slugify(meta.title) || "auto"}
              onChange={(e) => setMetaField("slug", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="f-tagline">Tagline</Label>
            <Input
              id="f-tagline"
              value={meta.tagline ?? ""}
              placeholder="One line on what this does for the student."
              onChange={(e) => setMetaField("tagline", e.target.value)}
            />
          </div>
          <div>
            <Label>Stage</Label>
            <Select
              value={meta.stage}
              onChange={(e) => setMetaField("stage", e.target.value as any)}
            >
              {FLOW_STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} — {s.blurb}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select
              value={meta.status}
              onChange={(e) => setMetaField("status", e.target.value as any)}
            >
              <option value="draft">Draft — only staff can open it</option>
              <option value="published">Published — students see it</option>
              <option value="archived">Archived — hidden everywhere</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="f-est">Estimated minutes</Label>
            <Input
              id="f-est"
              type="number"
              min={0}
              value={meta.est_minutes ?? ""}
              onChange={(e) =>
                setMetaField(
                  "est_minutes",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
            />
          </div>
          <div>
            <Label>Cohort</Label>
            <Select
              value={meta.cohort_id ?? ""}
              onChange={(e) => setMetaField("cohort_id", e.target.value || null)}
            >
              <option value="">Every cohort (standard)</option>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {/* ---- steps ---- */}
      <div className="grid gap-5 md:grid-cols-12">
        <div className="md:col-span-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Steps
          </p>
          <ul className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={s._uid}>
                <div
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    i === selected
                      ? "border-phosphor bg-phosphor/[0.06]"
                      : "border-line bg-paper hover:bg-wash"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm font-medium text-ink">
                      {s.title || s.step_key}
                    </span>
                    <span className="block text-[10px] font-mono uppercase tracking-wider text-ink-faint">
                      {s.kind} · {s.step_key}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => move(s._uid, -1)}
                    disabled={i === 0}
                    className="rounded p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(s._uid, 1)}
                    disabled={i === steps.length - 1}
                    className="rounded p-1 text-ink-faint hover:text-ink disabled:opacity-30"
                    aria-label="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(s._uid)}
                    disabled={steps.length === 1}
                    className="rounded p-1 text-ink-faint hover:text-red-500 disabled:opacity-30"
                    aria-label="Delete step"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {STEP_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                title={k.hint}
                onClick={() => addStep(k.value)}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink"
              >
                <Plus className="h-3 w-3" /> {k.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            Steps run top to bottom unless a choice option (or a step's
            "jump to") points somewhere else — that's how a flow branches
            and personalizes.
          </p>
        </div>

        {/* ---- selected step editor ---- */}
        <div className="md:col-span-8">
          {step && (
            <div className="rounded-xl border border-line bg-paper p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="s-key">Step key</Label>
                  <Input
                    id="s-key"
                    value={step.step_key}
                    onChange={(e) =>
                      patchStep(step._uid, { step_key: slugify(e.target.value) || e.target.value })
                    }
                  />
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Stable ID — branch targets and {"{{placeholders}}"} use it.
                  </p>
                </div>
                <div>
                  <Label htmlFor="s-title">Title</Label>
                  <Input
                    id="s-title"
                    value={step.title ?? ""}
                    onChange={(e) => patchStep(step._uid, { title: e.target.value })}
                  />
                </div>
              </div>
              <div className="mt-4">
                <Label htmlFor="s-body">Body</Label>
                <Textarea
                  id="s-body"
                  rows={8}
                  value={step.body ?? ""}
                  onChange={(e) => patchStep(step._uid, { body: e.target.value })}
                  placeholder="Markdown. Tables, lists, links all work."
                />
                <p className="mt-1 text-[11px] text-ink-faint">
                  Markdown supported. In outcome blocks you can reference
                  answers: {"{{step-key}}"} or {"{{step-key.field}}"}.
                </p>
              </div>

              {step.kind !== "choice" && step.kind !== "outcome" && (
                <div className="mt-4">
                  <Label>After this step, jump to</Label>
                  <Select
                    value={step.config.next ?? ""}
                    onChange={(e) =>
                      patchConfig(step._uid, { next: e.target.value || undefined })
                    }
                  >
                    <option value="">Next step in order</option>
                    {stepKeys
                      .filter((k) => k !== step.step_key)
                      .map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                  </Select>
                </div>
              )}

              {step.kind === "choice" && (
                <ChoiceEditor
                  step={step}
                  stepKeys={stepKeys}
                  onChange={(options) => patchConfig(step._uid, { options })}
                />
              )}
              {step.kind === "input" && (
                <InputEditor
                  step={step}
                  onChange={(fields) => patchConfig(step._uid, { fields })}
                />
              )}
              {step.kind === "checklist" && (
                <ChecklistEditor
                  step={step}
                  onChange={(items, requireAll) =>
                    patchConfig(step._uid, { items, requireAll })
                  }
                />
              )}
              {step.kind === "outcome" && (
                <OutcomeEditor
                  step={step}
                  choiceSteps={choiceSteps}
                  onChange={(blocks) => patchConfig(step._uid, { blocks })}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <div className="flex items-center gap-3">
          {meta.id && (
            <Button
              type="button"
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              Delete flow
            </Button>
          )}
          {meta.id && (
            <a
              href={`/dashboard/resources/flow/${meta.slug || slugify(meta.title)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-phosphor-ink hover:underline"
            >
              Preview as student <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : meta.id ? "Save flow" : "Create flow"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this flow?"
        description={
          <p>
            <span className="text-ink">{meta.title || "This flow"}</span> and
            every student's progress in it will be removed. This cannot be
            undone.
          </p>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => !pending && setConfirmDelete(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kind-specific editors
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
      {children}
    </p>
  );
}

function ChoiceEditor({
  step,
  stepKeys,
  onChange,
}: {
  step: BuilderStep;
  stepKeys: string[];
  onChange: (options: ChoiceOption[]) => void;
}) {
  const options = step.config.options ?? [];
  const patch = (i: number, p: Partial<ChoiceOption>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...p } : o)));
  return (
    <div>
      <SectionLabel>Options — each can jump to a different step</SectionLabel>
      <div className="space-y-3">
        {options.map((o, i) => (
          <div key={i} className="rounded-lg border border-line bg-wash p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={o.label}
                placeholder="Label the student sees"
                onChange={(e) =>
                  patch(i, {
                    label: e.target.value,
                    value: o.value || slugify(e.target.value),
                  })
                }
              />
              <Input
                value={o.value}
                placeholder="value (stable)"
                onChange={(e) => patch(i, { value: slugify(e.target.value) })}
              />
              <Input
                value={o.description ?? ""}
                placeholder="Optional sub-text"
                onChange={(e) => patch(i, { description: e.target.value || undefined })}
              />
              <Select
                value={o.next ?? ""}
                onChange={(e) => patch(i, { next: e.target.value || undefined })}
              >
                <option value="">→ next step in order</option>
                {stepKeys
                  .filter((k) => k !== step.step_key)
                  .map((k) => (
                    <option key={k} value={k}>
                      → {k}
                    </option>
                  ))}
              </Select>
            </div>
            <button
              type="button"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              className="mt-2 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-red-500"
            >
              <X className="h-3 w-3" /> Remove option
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...options,
            { value: `option-${options.length + 1}`, label: "" },
          ])
        }
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:text-ink"
      >
        <Plus className="h-3 w-3" /> Add option
      </button>
    </div>
  );
}

function InputEditor({
  step,
  onChange,
}: {
  step: BuilderStep;
  onChange: (fields: InputField[]) => void;
}) {
  const fields = step.config.fields ?? [];
  const patch = (i: number, p: Partial<InputField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div>
      <SectionLabel>Fields</SectionLabel>
      <div className="space-y-3">
        {fields.map((f, i) => (
          <div key={i} className="rounded-lg border border-line bg-wash p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={f.label}
                placeholder="Field label"
                onChange={(e) =>
                  patch(i, {
                    label: e.target.value,
                    key: f.key || slugify(e.target.value),
                  })
                }
              />
              <Input
                value={f.key}
                placeholder="key (used in {{step.key}})"
                onChange={(e) => patch(i, { key: slugify(e.target.value) })}
              />
              <Input
                value={f.placeholder ?? ""}
                placeholder="Placeholder text"
                onChange={(e) =>
                  patch(i, { placeholder: e.target.value || undefined })
                }
              />
              <Input
                value={(f.flags ?? []).join(", ")}
                placeholder='Garbage phrases to flag, e.g. "for everyone, AI-powered"'
                onChange={(e) =>
                  patch(i, {
                    flags: e.target.value
                      ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                      : undefined,
                  })
                }
              />
            </div>
            <div className="mt-2 flex items-center gap-4 text-xs text-ink-soft">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={f.multiline ?? false}
                  onChange={(e) => patch(i, { multiline: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[#ffbb00]"
                />
                Multiline
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={f.required !== false}
                  onChange={(e) => patch(i, { required: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[#ffbb00]"
                />
                Required
              </label>
              <button
                type="button"
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
                className="ml-auto inline-flex items-center gap-1 text-ink-faint hover:text-red-500"
              >
                <X className="h-3 w-3" /> Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...fields,
            { key: `field-${fields.length + 1}`, label: "", multiline: true },
          ])
        }
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:text-ink"
      >
        <Plus className="h-3 w-3" /> Add field
      </button>
    </div>
  );
}

function ChecklistEditor({
  step,
  onChange,
}: {
  step: BuilderStep;
  onChange: (items: ChecklistItem[], requireAll: boolean) => void;
}) {
  const items = step.config.items ?? [];
  const requireAll = step.config.requireAll ?? false;
  const patch = (i: number, p: Partial<ChecklistItem>) =>
    onChange(
      items.map((it, j) => (j === i ? { ...it, ...p } : it)),
      requireAll,
    );
  return (
    <div>
      <SectionLabel>Checklist items</SectionLabel>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              <Input
                value={it.label}
                placeholder="Item"
                onChange={(e) =>
                  patch(i, {
                    label: e.target.value,
                    key: it.key || slugify(e.target.value),
                  })
                }
              />
              <Input
                value={it.hint ?? ""}
                placeholder="Hint (optional)"
                onChange={(e) => patch(i, { hint: e.target.value || undefined })}
              />
            </div>
            <button
              type="button"
              onClick={() =>
                onChange(items.filter((_, j) => j !== i), requireAll)
              }
              className="mt-2 text-ink-faint hover:text-red-500"
              aria-label="Remove item"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() =>
            onChange(
              [...items, { key: `item-${items.length + 1}`, label: "" }],
              requireAll,
            )
          }
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:text-ink"
        >
          <Plus className="h-3 w-3" /> Add item
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={requireAll}
            onChange={(e) => onChange(items, e.target.checked)}
            className="h-3.5 w-3.5 accent-[#ffbb00]"
          />
          All items required to continue
        </label>
      </div>
    </div>
  );
}

function OutcomeEditor({
  step,
  choiceSteps,
  onChange,
}: {
  step: BuilderStep;
  choiceSteps: BuilderStep[];
  onChange: (blocks: OutcomeBlock[]) => void;
}) {
  const blocks = step.config.blocks ?? [];
  const patch = (i: number, p: Partial<OutcomeBlock>) =>
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...p } : b)));
  return (
    <div>
      <SectionLabel>
        Outcome blocks — shown when their condition matches (or always)
      </SectionLabel>
      <div className="space-y-3">
        {blocks.map((b, i) => {
          const condStep = choiceSteps.find(
            (s) => s.step_key === b.when?.step,
          );
          return (
            <div key={i} className="rounded-lg border border-line bg-wash p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Select
                  value={b.when?.step ?? ""}
                  onChange={(e) =>
                    patch(i, {
                      when: e.target.value
                        ? { step: e.target.value, in: b.when?.in ?? [] }
                        : undefined,
                    })
                  }
                >
                  <option value="">Always shown</option>
                  {choiceSteps.map((s) => (
                    <option key={s.step_key} value={s.step_key}>
                      When "{s.title || s.step_key}" is…
                    </option>
                  ))}
                </Select>
                <Input
                  value={(b.when?.in ?? []).join(", ")}
                  placeholder="matching values, comma-separated"
                  disabled={!b.when}
                  onChange={(e) =>
                    patch(i, {
                      when: b.when
                        ? {
                            step: b.when.step,
                            in: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          }
                        : undefined,
                    })
                  }
                />
              </div>
              {condStep && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  Values on that step:{" "}
                  {(condStep.config.options ?? [])
                    .map((o) => o.value)
                    .join(", ") || "—"}
                </p>
              )}
              <Input
                className="mt-2"
                value={b.title ?? ""}
                placeholder="Block title (optional)"
                onChange={(e) => patch(i, { title: e.target.value || undefined })}
              />
              <Textarea
                className="mt-2"
                rows={5}
                value={b.body}
                placeholder="Markdown. Reference answers with {{step-key}} or {{step-key.field}}."
                onChange={(e) => patch(i, { body: e.target.value })}
              />
              <button
                type="button"
                onClick={() => onChange(blocks.filter((_, j) => j !== i))}
                className="mt-2 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-red-500"
              >
                <X className="h-3 w-3" /> Remove block
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onChange([...blocks, { body: "" }])}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:text-ink"
      >
        <Plus className="h-3 w-3" /> Add block
      </button>
    </div>
  );
}
