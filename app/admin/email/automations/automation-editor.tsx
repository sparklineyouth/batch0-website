"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Trash2,
  Plus,
  Save,
  Play,
  GripVertical,
  Zap,
  Clock,
  Hand,
  Users,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  EVENT_GROUPS,
  AUDIENCE_SEGMENTS,
  STEP_CONDITIONS,
  DELAY_PRESETS,
  eventDef,
  formatDelay,
} from "@/lib/email/catalog";
import { CRON_PRESETS } from "@/lib/email/cron";
import {
  saveAutomation,
  deleteAutomation,
  previewAudienceCount,
  previewSchedule,
  runAutomationNow,
  type AutomationInput,
  type StepInput,
} from "./actions";

export type TemplateOption = {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
};

export type CohortOption = { id: string; name: string };

/**
 * The automation builder.
 *
 * Reads as a sentence top to bottom: *when* this happens, *who* it goes to,
 * *what* they get and *when*. That ordering isn't decoration — an automation
 * is the one admin object where getting the shape wrong sends real mail to
 * real people, and the failure is not recoverable by editing the row
 * afterwards.
 */
export function AutomationEditor({
  initial,
  templates,
  cohorts,
  lastRunAt,
  lastError,
}: {
  initial: AutomationInput;
  templates: TemplateOption[];
  cohorts: CohortOption[];
  lastRunAt?: string | null;
  lastError?: string | null;
}) {
  const router = useRouter();
  const [v, setV] = useState<AutomationInput>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [nextRuns, setNextRuns] = useState<string[]>([]);
  const [scheduleError, setScheduleError] = useState<string>();

  function set<K extends keyof AutomationInput>(k: K, val: AutomationInput[K]) {
    setV((p) => ({ ...p, [k]: val }));
    setNotice(undefined);
  }

  const isEvent = v.triggerType === "event";
  const trigger = isEvent ? eventDef(v.eventKey) : null;

  // Live audience count. An admin about to switch on a weekly send needs the
  // number *before* they save, not after the first Monday.
  useEffect(() => {
    if (isEvent) {
      setAudienceCount(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await previewAudienceCount(
          v.segment,
          v.cohortId,
          v.includeParents,
        );
        if (!cancelled && res.ok) setAudienceCount(res.count);
      } catch {
        /* count is advisory */
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isEvent, v.segment, v.cohortId, v.includeParents]);

  // The next three fires, so a hand-written cron can be checked against
  // reality rather than trusted.
  useEffect(() => {
    if (v.triggerType !== "schedule" || !v.scheduleCron.trim()) {
      setNextRuns([]);
      setScheduleError(undefined);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await previewSchedule(v.scheduleCron);
        if (cancelled) return;
        if (res.ok) {
          setNextRuns(res.runs);
          setScheduleError(undefined);
        } else {
          setNextRuns([]);
          setScheduleError(res.error);
        }
      } catch {
        /* advisory */
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [v.triggerType, v.scheduleCron]);

  function updateStep(i: number, patch: Partial<StepInput>) {
    set(
      "steps",
      v.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }

  function addStep() {
    const last = v.steps[v.steps.length - 1];
    set("steps", [
      ...v.steps,
      {
        templateId: "",
        // Default the next step to a sensible gap after the previous one
        // rather than to zero — two steps at the same instant is the one
        // configuration that's always wrong, and the validator rejects it.
        delayMinutes: last ? last.delayMinutes + 60 * 24 * 3 : 0,
        condition: "always",
        enabled: true,
      },
    ]);
  }

  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= v.steps.length) return;
    const next = [...v.steps];
    [next[i], next[j]] = [next[j], next[i]];
    set("steps", next);
  }

  function onSave() {
    setError(undefined);
    start(async () => {
      try {
        const res = await saveAutomation(v);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice("Saved.");
        if (!v.id) router.replace(`/admin/email/automations/${res.id}`);
        else router.refresh();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  function onDelete() {
    start(async () => {
      try {
        const res = await deleteAutomation(v.id!);
        if (!res.ok) {
          setError(res.error);
          setConfirmDelete(false);
          return;
        }
        router.push("/admin/email/automations");
      } catch (err) {
        setError(getActionError(err));
        setConfirmDelete(false);
      }
    });
  }

  function onRunNow() {
    setConfirmRun(false);
    start(async () => {
      try {
        const res = await runAutomationNow(v.id!);
        if (res.ok) setNotice(res.message);
        else setError(res.message);
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/admin/email/automations"
            className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> All automations
          </Link>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {v.id ? v.name || "Untitled automation" : "New automation"}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={v.enabled}
            onClick={() => set("enabled", !v.enabled)}
            className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-none active:scale-[0.98] ${
              v.enabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-line bg-wash text-ink-faint"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${v.enabled ? "bg-emerald-500" : "bg-ink-faint"}`}
              aria-hidden
            />
            {v.enabled ? "Live" : "Paused"}
          </button>
          {v.id && !isEvent && (
            <Button
              variant="secondary"
              onClick={() => setConfirmRun(true)}
              disabled={pending || !v.enabled}
            >
              <Play className="h-4 w-4" /> Run now
            </Button>
          )}
          {v.id && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <Button onClick={onSave} disabled={pending}>
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}
      {lastError && (
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Last run reported: <span className="text-ink">{lastError}</span>
          </span>
        </div>
      )}

      <div className="mt-6 space-y-5">
        <Card className="space-y-4">
          <div>
            <Label htmlFor="auto-name">Name</Label>
            <Input
              id="auto-name"
              value={v.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Accepted → payment nudge sequence"
            />
          </div>
          <div>
            <Label htmlFor="auto-desc">Internal note</Label>
            <Textarea
              id="auto-desc"
              value={v.description}
              onChange={(e) => set("description", e.target.value)}
              rows={2}
              placeholder="What this is for, and anything the next person should know before changing it."
            />
          </div>
        </Card>

        {/* ---- When ---- */}
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">When it runs</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              An event fires per person as it happens. A schedule fires for a
              whole audience on a clock. Manual only runs when you press the
              button.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <TriggerChoice
              icon={Zap}
              label="On an event"
              description="Someone applies, is accepted, pays…"
              active={v.triggerType === "event"}
              onClick={() => set("triggerType", "event")}
            />
            <TriggerChoice
              icon={Clock}
              label="On a schedule"
              description="Weekly, daily, monthly…"
              active={v.triggerType === "schedule"}
              onClick={() => set("triggerType", "schedule")}
            />
            <TriggerChoice
              icon={Hand}
              label="Manually"
              description="A saved send you fire yourself"
              active={v.triggerType === "manual"}
              onClick={() => set("triggerType", "manual")}
            />
          </div>

          {isEvent && (
            <div>
              <Label htmlFor="auto-event">Trigger event</Label>
              <Select
                id="auto-event"
                value={v.eventKey}
                onChange={(e) => set("eventKey", e.target.value)}
              >
                <option value="">Choose an event…</option>
                {EVENT_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.events.map((ev) => (
                      <option key={ev.key} value={ev.key}>
                        {ev.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
              {trigger && (
                <p className="mt-1.5 text-xs text-ink-soft">
                  {trigger.description} Available variables:{" "}
                  {[...trigger.variables].map((x) => (
                    <code key={x.key} className="mr-1 font-mono text-phosphor-ink">
                      {`{{${x.key}}}`}
                    </code>
                  ))}
                </p>
              )}
              <div className="mt-3 rounded-lg border border-line bg-wash px-3 py-2 text-xs text-ink-soft">
                Some of these events already send a built-in email of their own
                (the acceptance, the receipt). Building an automation on the same
                event adds a second message — use it for follow-ups and nudges,
                and edit the built-in template itself if you want to change the
                first one.
              </div>
            </div>
          )}

          {v.triggerType === "schedule" && (
            <div>
              <Label htmlFor="auto-cron">Schedule (UTC)</Label>
              <div className="grid gap-2 sm:grid-cols-[240px_1fr]">
                <Select
                  id="auto-cron-preset"
                  aria-label="Schedule preset"
                  value={
                    CRON_PRESETS.some((p) => p.value === v.scheduleCron)
                      ? v.scheduleCron
                      : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "custom") set("scheduleCron", e.target.value);
                  }}
                >
                  {CRON_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </Select>
                <Input
                  id="auto-cron"
                  value={v.scheduleCron}
                  onChange={(e) => set("scheduleCron", e.target.value)}
                  placeholder="0 14 * * 1"
                  className="font-mono text-xs"
                  error={Boolean(scheduleError)}
                />
              </div>
              {scheduleError ? (
                <p className="mt-1 text-xs text-red-500">{scheduleError}</p>
              ) : nextRuns.length > 0 ? (
                <p className="mt-1.5 text-xs text-ink-soft">
                  Next runs:{" "}
                  {nextRuns.map((r, i) => (
                    <span key={r}>
                      {i > 0 && " · "}
                      <LocalTime value={r} mode="datetime-short" />
                    </span>
                  ))}
                </p>
              ) : null}
              <p className="mt-1.5 text-xs text-ink-faint">
                The queue is checked every five minutes, so a schedule fires
                within a few minutes of its time. It never fires twice or gets
                skipped. Use{" "}
                <strong className="text-ink-soft">Run now</strong> if you need it
                to go immediately.
              </p>
            </div>
          )}
        </Card>

        {/* ---- Who ---- */}
        {!isEvent && (
          <Card className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Who it goes to</h2>
              <p className="mt-0.5 text-xs text-ink-soft">
                Resolved fresh on every run, so the list keeps up with who
                joined or left since you set it up.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="auto-segment">Audience</Label>
                <Select
                  id="auto-segment"
                  value={v.segment}
                  onChange={(e) => set("segment", e.target.value as any)}
                >
                  {AUDIENCE_SEGMENTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="auto-cohort">Cohort (optional)</Label>
                <Select
                  id="auto-cohort"
                  value={v.cohortId}
                  onChange={(e) => set("cohortId", e.target.value)}
                >
                  <option value="">Any cohort</option>
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={v.includeParents}
                onChange={(e) => set("includeParents", e.target.checked)}
                className="h-4 w-4 accent-phosphor"
              />
              Also send to the parent address on file, where there is one
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-wash px-3 py-2 text-sm text-ink-soft">
              <Users className="h-4 w-4 text-ink-faint" />
              {audienceCount === null
                ? "Counting…"
                : `${audienceCount} address${audienceCount === 1 ? "" : "es"} right now`}
            </div>
          </Card>
        )}

        {/* ---- What ---- */}
        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">What they get</h2>
              <p className="mt-0.5 text-xs text-ink-soft">
                Delays are measured from the trigger, not from the previous
                step — so changing one step never shifts the others.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={addStep}>
              <Plus className="h-4 w-4" /> Add step
            </Button>
          </div>

          {v.steps.length === 0 ? (
            <p className="text-sm text-ink-faint">
              No steps yet. Add one and pick the template it sends.
            </p>
          ) : (
            <ol className="space-y-3">
              {v.steps.map((s, i) => {
                const tpl = templates.find((t) => t.id === s.templateId);
                return (
                  <li
                    key={i}
                    className="rounded-xl border border-line bg-paper p-4"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-wash text-xs font-semibold text-ink-soft">
                        {i + 1}
                      </span>
                      <span className="text-xs font-medium text-ink-soft">
                        {formatDelay(s.delayMinutes)}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveStep(i, -1)}
                          disabled={i === 0}
                          className="px-1 text-xs text-ink-faint hover:text-ink disabled:opacity-30"
                          aria-label="Move step up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveStep(i, 1)}
                          disabled={i === v.steps.length - 1}
                          className="px-1 text-xs text-ink-faint hover:text-ink disabled:opacity-30"
                          aria-label="Move step down"
                        >
                          ↓
                        </button>
                        <label className="ml-2 flex items-center gap-1.5 text-xs text-ink-soft">
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={(e) =>
                              updateStep(i, { enabled: e.target.checked })
                            }
                            className="h-3.5 w-3.5 accent-phosphor"
                          />
                          on
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            set(
                              "steps",
                              v.steps.filter((_, idx) => idx !== i),
                            )
                          }
                          className="px-1 text-ink-faint hover:text-red-500"
                          aria-label="Remove step"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={`step-tpl-${i}`}>Template</Label>
                        <Select
                          id={`step-tpl-${i}`}
                          value={s.templateId}
                          onChange={(e) =>
                            updateStep(i, { templateId: e.target.value })
                          }
                        >
                          <option value="">Choose a template…</option>
                          {templates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                              {t.enabled ? "" : " (disabled)"}
                            </option>
                          ))}
                        </Select>
                        {tpl && !tpl.enabled && (
                          <p className="mt-1 text-xs text-amber-600">
                            This template is disabled — the step will skip
                            rather than send.
                          </p>
                        )}
                        {tpl && (
                          <Link
                            href={`/admin/email/templates/${tpl.id}`}
                            className="mt-1 inline-block text-xs text-phosphor-ink hover:underline"
                          >
                            Edit this template →
                          </Link>
                        )}
                      </div>
                      <div>
                        <Label htmlFor={`step-delay-${i}`}>Send</Label>
                        <Select
                          id={`step-delay-${i}`}
                          value={
                            DELAY_PRESETS.some((p) => p.minutes === s.delayMinutes)
                              ? String(s.delayMinutes)
                              : "custom"
                          }
                          onChange={(e) => {
                            if (e.target.value !== "custom") {
                              updateStep(i, { delayMinutes: Number(e.target.value) });
                            }
                          }}
                        >
                          {DELAY_PRESETS.map((p) => (
                            <option key={p.minutes} value={p.minutes}>
                              {p.label}
                            </option>
                          ))}
                          <option value="custom">Custom…</option>
                        </Select>
                        {!DELAY_PRESETS.some((p) => p.minutes === s.delayMinutes) && (
                          <div className="mt-2 flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              value={s.delayMinutes}
                              onChange={(e) =>
                                updateStep(i, {
                                  delayMinutes: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                              aria-label="Delay in minutes"
                            />
                            <span className="whitespace-nowrap text-xs text-ink-faint">
                              minutes after the trigger
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-3">
                      <Label htmlFor={`step-cond-${i}`}>Only send if</Label>
                      <Select
                        id={`step-cond-${i}`}
                        value={s.condition}
                        onChange={(e) =>
                          updateStep(i, { condition: e.target.value as any })
                        }
                      >
                        {STEP_CONDITIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                      <p className="mt-1 text-xs text-ink-soft">
                        {
                          STEP_CONDITIONS.find((c) => c.value === s.condition)
                            ?.description
                        }{" "}
                        Checked when the email is about to send, not when it was
                        queued.
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <Card className="space-y-3">
          <div>
            <Label htmlFor="auto-dedupe">Don't repeat within</Label>
            <div className="flex items-center gap-2">
              <Input
                id="auto-dedupe"
                type="number"
                min={0}
                max={2160}
                value={v.dedupeWindowHours}
                onChange={(e) =>
                  set("dedupeWindowHours", Math.max(0, Number(e.target.value) || 0))
                }
                className="max-w-[120px]"
              />
              <span className="text-sm text-ink-soft">hours</span>
            </div>
          </div>
          <p className="text-xs text-ink-soft">
            A safety net for repeated triggers: the same person can't receive
            the same step twice inside this window. Leave it at 24 unless you
            have a reason.
          </p>
          {lastRunAt && (
            <p className="text-xs text-ink-faint">
              Last run: <LocalTime value={lastRunAt} mode="datetime-short" />
            </p>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        title="Delete this automation?"
        description="Its steps go with it, and anything it has queued but not yet sent is cancelled."
        confirmLabel="Delete"
        pending={pending}
        destructive
      />
      <ConfirmDialog
        open={confirmRun}
        onCancel={() => setConfirmRun(false)}
        onConfirm={onRunNow}
        title="Run this now?"
        description={`This queues real email to the ${
          audienceCount ?? "current"
        } address${audienceCount === 1 ? "" : "es"} in the audience. It sends on the next queue run and can be cancelled from the outbox until then.`}
        confirmLabel="Queue it"
        pending={pending}
      />
    </div>
  );
}

function TriggerChoice({
  icon: Icon,
  label,
  description,
  active,
  onClick,
}: {
  icon: typeof Zap;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-xl border p-3 text-left transition-none active:scale-[0.99] ${
        active
          ? "border-phosphor bg-phosphor/10"
          : "border-line bg-paper hover:border-ink/30 hover:bg-wash"
      }`}
    >
      <Icon
        className={`h-4 w-4 ${active ? "text-phosphor-ink" : "text-ink-faint"}`}
      />
      <div className="mt-1.5 text-sm font-semibold text-ink">{label}</div>
      <div className="mt-0.5 text-xs text-ink-soft">{description}</div>
    </button>
  );
}
