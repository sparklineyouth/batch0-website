"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Send } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { isE164 } from "@/lib/phone";
import { measureSms } from "@/lib/sms/segments";
import { saveSmsSettings, toggleSmsPause, type SmsSettingsInput } from "./actions";

export type SmsSettingsFormProps = {
  initial: SmsSettingsInput & { authTokenSet: boolean };
  /** False when 0106 hasn't run — nothing here has anywhere to save. */
  tablesReady: boolean;
  /** smsTransportStatus() from the server: what will actually happen on a send. */
  status: { ok: boolean; detail: string };
};

const START_HOURS = Array.from({ length: 24 }, (_, i) => i); // 0–23, inclusive
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1); // 1–24, exclusive

/** "9:00 AM". 24 is the exclusive end of the day, which reads as midnight. */
function hourLabel(h: number): string {
  if (h === 24) return "midnight";
  if (h === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

export function SmsSettingsForm({ initial, tablesReady, status }: SmsSettingsFormProps) {
  const router = useRouter();
  const [v, setV] = useState<SmsSettingsInput>({ ...initial, authToken: "" });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  function set<K extends keyof SmsSettingsInput>(k: K, val: SmsSettingsInput[K]) {
    setV((p) => ({ ...p, [k]: val }));
    setNotice(undefined);
    setError(undefined);
  }

  /**
   * `onFailure` exists for the kill switch, which writes optimistically: if the
   * action is refused, the switch has to go back or it sits there claiming a
   * pause that never happened. It must touch `setV` directly rather than `set`,
   * which clears the error that was just shown.
   */
  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    onFailure?: () => void,
  ) {
    start(async () => {
      setError(undefined);
      setNotice(undefined);
      try {
        const res = await fn();
        if (res.ok) {
          setNotice("Saved.");
          // Re-runs smsTransportStatus() on the server so the strip at the top
          // reflects the credential that was just stored, not the old one.
          router.refresh();
        } else {
          setError(res.error ?? "Something went wrong.");
          onFailure?.();
        }
      } catch (err) {
        setError(getActionError(err));
        onFailure?.();
      }
    });
  }

  const from = v.fromNumber.trim();
  const fromError =
    from && !isE164(from)
      ? "Not E.164 — needs a leading + and digits only, e.g. +18005550123."
      : undefined;

  // A window whose start is at or after its end is not "overnight", it is a
  // window no hour satisfies: nextAllowedSend() returns null and every message
  // parks as skipped. Surfaced here as well as refused server-side, because the
  // two selects are where the mistake is made.
  const windowImpossible = v.quietStartHour >= v.quietEndHour;

  // The disclosure is appended to the FIRST message each number receives, so
  // its length and its encoding are both charged to that message.
  const help = measureSms(v.helpText);
  const disclosureMisses = [
    !/batch0/i.test(v.helpText) && "the brand name (batch0)",
    !/\bstop\b/i.test(v.helpText) && "an opt-out instruction (STOP)",
    !/(rates|msg\s*&\s*data|message and data)/i.test(v.helpText) &&
      "a rates notice (Msg&data rates may apply)",
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        SMS settings
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        The number texts come from, the hours they're allowed to arrive, and the
        switch that stops all of it.
      </p>

      {!tablesReady && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            Texting isn&rsquo;t set up yet: run migration{" "}
            <code className="font-mono text-phosphor-ink">0106_sms_messaging.sql</code>{" "}
            first. Until then these settings have nowhere to save and texting is
            inert.
          </p>
        </Card>
      )}

      {/* Live status, from the server. The one thing on this page that reflects
          what a send would actually do rather than what is typed in a field. */}
      <div
        className={`mt-5 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          status.ok
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-amber-500/30 bg-amber-500/5"
        }`}
      >
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
            status.ok ? "bg-emerald-500" : "bg-amber-500"
          }`}
        />
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {status.ok ? "Texts are going out" : "Nothing is going out"}
          </p>
          <p className="mt-0.5 text-xs text-ink-soft">{status.detail}</p>
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

      <div className="mt-6 space-y-5">
        {/* ---- Kill switch, first because it's the one you come here for ---- */}
        <Card>
          <Toggle
            label={v.smsPaused ? "Sending is paused" : "Sending is live"}
            description={
              v.smsPaused
                ? "Nothing is leaving. Every message — campaigns and transactional alike — collects in the outbox as pending and goes out when you resume. Nothing is dropped and nothing expires."
                : "Messages send on the next queue drain. Pausing stops future sends only; it can't recall anything already delivered."
            }
            checked={!v.smsPaused}
            onChange={(next) => {
              set("smsPaused", !next);
              run(
                () => toggleSmsPause(!next),
                () => setV((p) => ({ ...p, smsPaused: next })),
              );
            }}
            disabled={pending || !tablesReady}
          />
        </Card>

        {/* ---- Provider + credentials ---- */}
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Provider</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Credentials live here rather than in the environment so switching
              numbers after a carrier rejection is a save, not a deploy.
            </p>
          </div>

          <div>
            <Label htmlFor="provider">Sending through</Label>
            <Select
              id="provider"
              value={v.provider}
              onChange={(e) => set("provider", e.target.value as "twilio" | "telnyx")}
            >
              <option value="twilio">Twilio</option>
              {/* The column accepts 'telnyx' so adding it later needs no
                  migration, but lib/sms/providers/index.ts throws for it. A
                  selectable option that breaks every send is worse than one
                  that can't be picked. */}
              <option value="telnyx" disabled>
                Telnyx — not implemented yet
              </option>
            </Select>
            {v.provider === "telnyx" && (
              <p className="mt-1.5 text-xs text-amber-600">
                This row is set to Telnyx, which has no implementation — every
                send is currently throwing. Switch to Twilio and save.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="account-sid">Account SID</Label>
              <Input
                id="account-sid"
                value={v.accountSid}
                onChange={(e) => set("accountSid", e.target.value)}
                placeholder="AC…"
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="auth-token">
                {initial.authTokenSet ? "Replace auth token" : "Auth token"}
              </Label>
              <Input
                id="auth-token"
                type="password"
                value={v.authToken}
                onChange={(e) => set("authToken", e.target.value)}
                placeholder={
                  initial.authTokenSet ? "•••••••• (leave blank to keep)" : "Twilio auth token"
                }
                autoComplete="new-password"
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-ink-faint">
                Stored encrypted and never shown again — leave it blank to keep
                the one on file. It also signs inbound webhooks, so replacing it
                with the wrong value makes every STOP fail verification.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="from-number">Sending number</Label>
            <Input
              id="from-number"
              value={v.fromNumber}
              onChange={(e) => set("fromNumber", e.target.value)}
              placeholder="+18005550123"
              className="font-mono text-xs"
              error={fromError}
              autoComplete="off"
            />
            <FieldError id="from-number-error">{fromError}</FieldError>
            <p className="mt-1 text-xs text-ink-soft">
              E.164 — a leading <code className="font-mono">+</code>, the country
              code, then digits with no spaces or brackets. batch0 sends from a
              verified US toll-free number, so this is{" "}
              <code className="font-mono">+1</code> followed by ten digits.
              Toll-free traffic only reaches North American numbers; anything
              else is filtered out before it's queued.
            </p>
          </div>
        </Card>

        {/* ---- Quiet hours ---- */}
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Quiet hours</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              In the <strong>recipient's</strong> local time, inferred from their
              area code. A message composed outside the window is queued for the
              next allowed moment, never dropped — so a 2am alert arrives at
              opening time instead of disappearing.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="quiet-start">Earliest send</Label>
              <Select
                id="quiet-start"
                value={String(v.quietStartHour)}
                onChange={(e) => set("quietStartHour", Number(e.target.value))}
              >
                {START_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="quiet-end">Latest send (exclusive)</Label>
              <Select
                id="quiet-end"
                value={String(v.quietEndHour)}
                onChange={(e) => set("quietEndHour", Number(e.target.value))}
              >
                {END_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {windowImpossible ? (
            <p className="text-xs text-red-700 dark:text-red-300">
              {hourLabel(v.quietStartHour)} to {hourLabel(v.quietEndHour)} is a
              window no hour can satisfy — the window doesn't wrap past midnight.
              Every message would be parked as <code className="font-mono">skipped</code>{" "}
              instead of sent. Put the earliest before the latest.
            </p>
          ) : (
            <p className="text-xs text-ink-soft">
              Texts may arrive between <strong>{hourLabel(v.quietStartHour)}</strong>{" "}
              and <strong>{hourLabel(v.quietEndHour)}</strong> where the recipient
              is. Federal law allows 8am–9pm; Florida and Oklahoma are stricter,
              so the 9am–8pm default sits inside all three. When the area code
              maps to no timezone, the send has to be polite in both Eastern and
              Pacific, which narrows the window on its own.
            </p>
          )}
        </Card>

        {/* ---- Throughput ---- */}
        <Card className="space-y-3">
          <div>
            <Label htmlFor="max-sends">Messages per queue run</Label>
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
            The drain sends at most this many each time it runs (every five
            minutes), and anything left over goes on the next run. It also caps
            itself at <strong>60</strong> per run whatever this says: it paces
            sends 350ms apart to stay under what a toll-free number is
            provisioned for, and 60 is what fits in the function&rsquo;s 60
            seconds.
          </p>
        </Card>

        {/* ---- Disclosure ---- */}
        <Card className="space-y-3">
          <div>
            <Label htmlFor="help-text">First-message disclosure</Label>
            {/* A textarea rather than an input because the whole string has to
                be readable at once — the check below is that three specific
                things are present in it, and you can't audit what's scrolled
                out of view. */}
            <Textarea
              id="help-text"
              rows={3}
              value={v.helpText}
              onChange={(e) => set("helpText", e.target.value)}
              placeholder="batch0: Reply STOP to opt out, HELP for help. Msg&data rates may apply."
            />
          </div>
          <p className="text-xs text-ink-soft">
            Appended once, to the first message a number ever receives from us —
            not to every message. CTIA requires three things in it: the brand
            name, an opt-out instruction, and a rates notice. Trimming it below
            those is what gets a toll-free number's verification pulled, and a
            pulled number means every message silently stops being delivered.
          </p>
          {disclosureMisses.length > 0 && (
            <p className="text-xs text-amber-600">
              Missing {disclosureMisses.join(", ")}. Saving is allowed, but the
              number's verification is the thing at risk.
            </p>
          )}
          <p className="text-xs text-ink-faint">
            {help.units}/{help.capacity} characters of the first segment
            {help.segments > 1 ? ` · ${help.segments} segments on its own` : ""}.
            {help.nonGsmChars.length > 0 && (
              <>
                {" "}
                Contains {help.nonGsmChars.slice(0, 4).join(" ")} — non-GSM
                characters here force the whole first message into UCS-2, where a
                segment holds 70 characters instead of 160.
              </>
            )}
          </p>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => run(() => saveSmsSettings(v))}
            disabled={pending || Boolean(fromError) || windowImpossible}
          >
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save settings"}
          </Button>
          {/* No test-send here on purpose: a real test needs a recipient with
              consent on file, which is the campaign page's job and where the
              affordance already lives. */}
          <ButtonLink href="/admin/sms/blast" variant="secondary">
            <Send className="h-4 w-4" /> Send a test from the campaign page
          </ButtonLink>
        </div>
        <p className="text-xs text-ink-faint">
          Saved changes reach the queue within 30 seconds — that's the settings
          cache the drain reads through.
        </p>
      </div>
    </div>
  );
}
