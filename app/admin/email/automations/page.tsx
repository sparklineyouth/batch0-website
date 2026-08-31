import Link from "next/link";
import { Plus, Zap, Clock, Hand, Workflow } from "lucide-react";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { listAutomations, listTemplates } from "@/lib/email/store";
import { getEmailSettings } from "@/lib/email/settings";
import { eventDef, formatDelay } from "@/lib/email/catalog";
import { describeCron } from "@/lib/email/cron";

export const metadata = { title: "Email automations · Admin" };
export const dynamic = "force-dynamic";

const TRIGGER_ICON = { event: Zap, schedule: Clock, manual: Hand } as const;

export default async function EmailAutomationsPage() {
  const [{ automations, missingTable }, { templates }, settings] = await Promise.all([
    listAutomations(),
    listTemplates(),
    getEmailSettings(),
  ]);

  if (missingTable) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Email automations
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0052_email_automation.sql
            </code>{" "}
            to enable automations.
          </p>
        </Card>
      </div>
    );
  }

  const templateName = new Map(templates.map((t) => [t.id, t.name]));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Email automations
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Rules that send email on their own — when something happens, on a
            schedule, or a saved send you fire by hand. Each one is a sequence
            of templates with delays between them.
          </p>
        </div>
        <Link
          href="/admin/email/automations/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-phosphor px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <Plus className="h-4 w-4" /> New automation
        </Link>
      </div>

      {settings.automationsPaused && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            <strong className="text-ink">All automated sending is paused.</strong>{" "}
            Nothing below is going out, whatever its own switch says. Resume at{" "}
            <Link href="/admin/email/settings" className="underline">
              email settings
            </Link>
            .
          </p>
        </Card>
      )}

      {templates.length === 0 && (
        <Card className="mt-5">
          <p className="text-sm text-ink-soft">
            There are no templates yet, and an automation needs at least one.{" "}
            <Link href="/admin/email/templates" className="text-phosphor-ink underline">
              Add the built-in templates
            </Link>{" "}
            to get started.
          </p>
        </Card>
      )}

      {automations.length === 0 ? (
        <Card className="mt-6 text-center">
          <Workflow className="mx-auto h-8 w-8 text-ink-faint" />
          <p className="mt-3 text-sm text-ink-soft">
            No automations yet. A good first one: on{" "}
            <em>Application accepted</em>, send the payment nudge three days
            later, only if they still haven't paid.
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {automations.map((a) => {
            const Icon = TRIGGER_ICON[a.trigger_type] ?? Zap;
            const ev = a.event_key ? eventDef(a.event_key) : null;
            return (
              <Link
                key={a.id}
                href={`/admin/email/automations/${a.id}`}
                className="block rounded-2xl border border-line bg-wash p-5 hover:border-ink/30 hover:bg-paper"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Icon
                    className={`h-4 w-4 ${a.enabled ? "text-phosphor-ink" : "text-ink-faint"}`}
                  />
                  <span className="font-medium text-ink">{a.name}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      a.enabled
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-line text-ink-faint"
                    }`}
                  >
                    {a.enabled ? "live" : "paused"}
                  </span>
                  {a.last_error && (
                    <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      last run errored
                    </span>
                  )}
                  {a.last_run_at && (
                    <span className="ml-auto text-xs text-ink-faint">
                      ran <LocalTime value={a.last_run_at} mode="datetime-short" />
                    </span>
                  )}
                </div>

                <p className="mt-2 text-sm text-ink-soft">
                  {a.trigger_type === "event"
                    ? `When: ${ev?.label ?? a.event_key}`
                    : a.trigger_type === "schedule"
                      ? `Every: ${describeCron(a.schedule_cron ?? "")}`
                      : "Runs when you press the button"}
                </p>

                {a.steps.length > 0 && (
                  <ol className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                    {a.steps.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-2">
                        {i > 0 && <span aria-hidden>→</span>}
                        <span className={s.enabled ? "" : "line-through opacity-60"}>
                          {templateName.get(s.template_id) ?? "deleted template"}
                          <span className="ml-1 text-ink-faint">
                            ({formatDelay(s.delay_minutes)})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
