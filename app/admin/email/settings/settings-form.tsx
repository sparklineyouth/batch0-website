"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Plug, Send, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { SMTP_PRESETS } from "@/lib/email/catalog";
import {
  saveEmailSettings,
  testConnection,
  sendSettingsTest,
  setAutomationsPaused,
  type EmailSettingsInput,
} from "./actions";

export type SettingsFormProps = {
  initial: EmailSettingsInput & { smtpPasswordSet: boolean };
  resendConfigured: boolean;
  tablesReady: boolean;
};

/** Which preset a stored host corresponds to, so the form reopens where it was. */
function presetFor(host: string): string {
  const match = SMTP_PRESETS.find((p) => p.host && p.host === host);
  return match?.value ?? "custom";
}

export function EmailSettingsForm({
  initial,
  resendConfigured,
  tablesReady,
}: SettingsFormProps) {
  const router = useRouter();
  const [v, setV] = useState<EmailSettingsInput>({ ...initial, smtpPassword: "" });
  const [preset, setPreset] = useState(() => presetFor(initial.smtpHost));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  function set<K extends keyof EmailSettingsInput>(k: K, val: EmailSettingsInput[K]) {
    setV((p) => ({ ...p, [k]: val }));
    setNotice(undefined);
    setError(undefined);
  }

  function applyPreset(value: string) {
    setPreset(value);
    const p = SMTP_PRESETS.find((x) => x.value === value);
    if (!p || value === "custom") return;
    setV((prev) => ({
      ...prev,
      smtpHost: p.host,
      smtpPort: p.port,
      smtpSecure: p.secure,
    }));
  }

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      setError(undefined);
      setNotice(undefined);
      try {
        const res = await fn();
        if (res.ok) {
          setNotice(res.message ?? "Saved.");
          router.refresh();
        } else {
          setError(res.error ?? res.message ?? "Something went wrong.");
        }
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  const presetHelp = SMTP_PRESETS.find((p) => p.value === preset)?.help;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Email settings
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Where email goes out from, and the switch that stops all of it.
      </p>

      {!tablesReady && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0052_email_automation.sql
            </code>{" "}
            before changing anything here — until then these settings have
            nowhere to save, and email uses the environment variables.
          </p>
        </Card>
      )}

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

      <div className="mt-6 space-y-5">
        {/* ---- Kill switch, first because it's the one you come here for ---- */}
        <Card>
          <Toggle
            label={
              v.automationsPaused ? "Automated sending is paused" : "Automated sending is live"
            }
            description={
              v.automationsPaused
                ? "Nothing automated is going out. Due email collects in the outbox and sends when you resume."
                : "Automations and scheduled sends run normally. Pausing does not affect anything already delivered."
            }
            checked={!v.automationsPaused}
            onChange={(next) => {
              set("automationsPaused", !next);
              run(() => setAutomationsPaused(!next));
            }}
            disabled={pending || !tablesReady}
          />
        </Card>

        {/* ---- Transport ---- */}
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">How email is sent</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Resend is the default and what the batch0.org domain is verified
              against. SMTP lets you send through a Gmail account or any other
              relay instead — useful when you want mail to come from a real
              mailbox you can reply from.
            </p>
          </div>

          <div>
            <Label htmlFor="transport">Transport</Label>
            <Select
              id="transport"
              value={v.transport}
              onChange={(e) => set("transport", e.target.value as "resend" | "smtp")}
            >
              <option value="resend">Resend (API)</option>
              <option value="smtp">SMTP — Gmail, Outlook, or any relay</option>
            </Select>
            {v.transport === "resend" && !resendConfigured && (
              <p className="mt-1.5 text-xs text-amber-600">
                RESEND_API_KEY isn't set in this environment, so nothing will
                actually send. Set it, or switch to SMTP.
              </p>
            )}
          </div>

          {v.transport === "smtp" && (
            <div className="space-y-4 rounded-xl border border-line bg-paper p-4">
              <div>
                <Label htmlFor="smtp-preset">Provider</Label>
                <Select
                  id="smtp-preset"
                  value={preset}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {SMTP_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                {presetHelp && (
                  <p className="mt-1.5 text-xs text-ink-soft">{presetHelp}</p>
                )}
                {preset === "gmail" && (
                  <a
                    href="https://myaccount.google.com/apppasswords"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-phosphor-ink hover:underline"
                  >
                    Create a Google App Password
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <div>
                  <Label htmlFor="smtp-host">Host</Label>
                  <Input
                    id="smtp-host"
                    value={v.smtpHost}
                    onChange={(e) => set("smtpHost", e.target.value)}
                    placeholder="smtp.gmail.com"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="smtp-port">Port</Label>
                  <Input
                    id="smtp-port"
                    type="number"
                    value={v.smtpPort || ""}
                    onChange={(e) => set("smtpPort", Number(e.target.value) || 0)}
                    placeholder="587"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={v.smtpSecure}
                  onChange={(e) => set("smtpSecure", e.target.checked)}
                  className="h-4 w-4 accent-phosphor"
                />
                Implicit TLS (tick this for port 465; leave it off for 587)
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="smtp-user">Username</Label>
                  <Input
                    id="smtp-user"
                    value={v.smtpUser}
                    onChange={(e) => set("smtpUser", e.target.value)}
                    placeholder="you@gmail.com"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="smtp-pass">
                    {initial.smtpPasswordSet ? "Replace password" : "App password"}
                  </Label>
                  <Input
                    id="smtp-pass"
                    type="password"
                    value={v.smtpPassword}
                    onChange={(e) => set("smtpPassword", e.target.value)}
                    placeholder={
                      initial.smtpPasswordSet ? "•••••••• (leave blank to keep)" : "abcd efgh ijkl mnop"
                    }
                    autoComplete="new-password"
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    Stored encrypted and never shown again. For Gmail this is an
                    App Password, not your account password.
                  </p>
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* ---- Sender ---- */}
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Sender</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              What recipients see in the From line. A template can override this
              individually.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="from-name">From name</Label>
              <Input
                id="from-name"
                value={v.fromName}
                onChange={(e) => set("fromName", e.target.value)}
                placeholder="batch0"
              />
            </div>
            <div>
              <Label htmlFor="from-email">From address</Label>
              <Input
                id="from-email"
                value={v.fromEmail}
                onChange={(e) => set("fromEmail", e.target.value)}
                placeholder="hello@batch0.org"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="reply-to">Reply-to</Label>
            <Input
              id="reply-to"
              value={v.replyTo}
              onChange={(e) => set("replyTo", e.target.value)}
              placeholder="hello@batch0.org"
            />
          </div>
          {v.transport === "smtp" && v.smtpUser && v.fromEmail !== v.smtpUser && (
            <p className="text-xs text-amber-600">
              Gmail and most relays only let you send as the mailbox you signed
              in with, or an alias it owns. Sending as{" "}
              <code className="font-mono">{v.fromEmail}</code> from{" "}
              <code className="font-mono">{v.smtpUser}</code> will be rewritten
              or rejected — use the test button below before you rely on it.
            </p>
          )}
        </Card>

        {/* ---- Throughput ---- */}
        <Card className="space-y-3">
          <div>
            <Label htmlFor="max-sends">Emails per queue run</Label>
            <Input
              id="max-sends"
              type="number"
              min={1}
              max={2000}
              value={v.maxSendsPerRun}
              onChange={(e) => set("maxSendsPerRun", Number(e.target.value) || 0)}
              className="max-w-[140px]"
            />
          </div>
          <p className="text-xs text-ink-soft">
            The queue drains this many at most each time it runs. Keeps a large
            automation inside the serverless time limit, and keeps a burst from
            tripping a provider's rate limit — Gmail in particular. Anything
            left over goes on the next run a few minutes later.
          </p>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run(() => saveEmailSettings(v))} disabled={pending}>
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save settings"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => run(testConnection)}
            disabled={pending}
          >
            <Plug className="h-4 w-4" /> Test connection
          </Button>
          <Button
            variant="secondary"
            onClick={() => run(sendSettingsTest)}
            disabled={pending}
          >
            <Send className="h-4 w-4" /> Send me a test email
          </Button>
        </div>
        <p className="text-xs text-ink-faint">
          Save first — both tests use what's stored, not what's on screen.
        </p>
      </div>
    </div>
  );
}
