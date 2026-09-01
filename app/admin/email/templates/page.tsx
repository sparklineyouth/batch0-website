import Link from "next/link";
import { Plus, Lock, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { listTemplates } from "@/lib/email/store";
import { createAdminClient } from "@/lib/supabase/admin";
import { TEMPLATE_CATEGORIES } from "@/lib/email/catalog";
import { SeedButton } from "./seed-button";

export const metadata = { title: "Email templates · Admin" };
export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  TEMPLATE_CATEGORIES.map((c) => [c.value, c.label]),
);

export default async function EmailTemplatesPage() {
  const { templates, missingTable } = await listTemplates();

  // How many automation steps point at each template. Shown on the row
  // because "can I change this?" is the first question an admin has about a
  // template they didn't write, and the answer is whether anything sends it.
  const usage = new Map<string, number>();
  if (!missingTable) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("email_automation_steps")
      .select("template_id");
    for (const row of (data ?? []) as any[]) {
      usage.set(row.template_id, (usage.get(row.template_id) ?? 0) + 1);
    }
  }

  if (missingTable) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Email templates
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0052_email_automation.sql
            </code>{" "}
            (<code className="font-mono">supabase db push</code> from the repo
            root) to create the template, automation, and outbox tables. Until
            then every email still sends — from the copy compiled into{" "}
            <code className="font-mono text-phosphor-ink">
              lib/email/templates.ts
            </code>{" "}
            — it just isn't editable here.
          </p>
        </Card>
      </div>
    );
  }

  const byCategory = TEMPLATE_CATEGORIES.map((c) => ({
    ...c,
    items: templates.filter((t) => t.category === c.value),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Email templates
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Every email the site sends, editable here. Built-in templates start
            as the copy that's already going out; edit one and the new wording
            takes effect on the next send — no deploy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SeedButton />
          <Link
            href="/admin/email/templates/new"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-phosphor px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <Plus className="h-4 w-4" /> New template
          </Link>
        </div>
      </div>

      {templates.length === 0 ? (
        <Card className="mt-6 text-center">
          <FileText className="mx-auto h-8 w-8 text-ink-faint" />
          <p className="mt-3 text-sm text-ink-soft">
            No templates yet. Add the built-in ones to start from the copy the
            app already sends, or write a new one from scratch.
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          {byCategory.map((group) => (
            <section key={group.value}>
              <h2 className="mb-2 text-xs font-mono font-medium uppercase tracking-wider text-ink-faint">
                {group.label}
              </h2>
              <Card className="!p-0 overflow-hidden">
                <ul>
                  {group.items.map((t) => {
                    const used = usage.get(t.id) ?? 0;
                    return (
                      <li key={t.id} className="border-b border-line last:border-0">
                        <Link
                          href={`/admin/email/templates/${t.id}`}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5 hover:bg-wash"
                        >
                          <span className="font-medium text-ink">{t.name}</span>
                          {t.is_system && (
                            <span
                              title="Built in — the app sends this by name"
                              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint"
                            >
                              <Lock className="h-2.5 w-2.5" /> built-in
                            </span>
                          )}
                          {!t.enabled && (
                            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              disabled
                            </span>
                          )}
                          {used > 0 && (
                            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                              {used} automation step{used === 1 ? "" : "s"}
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-4 text-xs text-ink-faint">
                            <span className="font-mono">{t.key}</span>
                            <LocalTime value={t.updated_at} mode="datetime-short" />
                          </span>
                          <span className="w-full truncate text-xs text-ink-soft">
                            {t.subject || <em>no subject</em>}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
