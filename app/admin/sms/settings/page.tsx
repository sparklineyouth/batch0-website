import { Card } from "@/components/ui/card";
import { env } from "@/lib/env";
import { getPublicSmsSettings } from "@/lib/sms/settings";
import { smsTransportStatus } from "@/lib/sms/send";
import { smsWebhookConsoleUrl } from "@/lib/sms/webhook-url";
import { SmsSettingsForm } from "./settings-form";

export const metadata = { title: "SMS settings · Admin" };
export const dynamic = "force-dynamic";

export default async function SmsSettingsPage() {
  // getPublicSmsSettings drops the decrypted auth token before this object
  // exists, so the credential can never be serialized into the page payload.
  // smsTransportStatus reads the same 30-second-cached row, so asking for both
  // costs one query.
  const [s, status] = await Promise.all([getPublicSmsSettings(), smsTransportStatus()]);

  // With Twilio's retry override on the end (lib/sms/webhook-url.ts): without
  // it, Twilio drops any request the route answers with a 500, including an
  // opt-out it couldn't write.
  const webhookUrl = smsWebhookConsoleUrl(env.siteUrl);

  return (
    <div className="mx-auto max-w-2xl">
      {/* A failed read is fail-closed for sending (lib/sms/settings.ts), so it
          gets its own notice rather than being folded into the status strip —
          nothing on this page is trustworthy while it's set. */}
      {s.readError && (
        <Card className="mb-5 border-red-500/30 bg-red-500/5">
          <p className="text-sm text-ink">
            The settings row could not be read:{" "}
            <span className="font-mono text-xs">{s.readError}</span>
          </p>
          <p className="mt-2 text-xs text-ink-soft">
            Sending is refused while this persists — the row carries the
            quiet-hours window and the pause switch, and sending on defaults
            risks a message arriving at 6am local. The fields below show
            defaults, not what's stored; fix the read before saving over it.
          </p>
        </Card>
      )}

      <SmsSettingsForm
        initial={{
          provider: s.provider,
          fromNumber: s.fromNumber ?? "",
          accountSid: s.accountSid ?? "",
          // Always blank. The form shows whether a token is on file; the value
          // itself is write-only and blank on save means "keep it".
          authToken: "",
          smsPaused: s.smsPaused,
          maxSendsPerRun: s.maxSendsPerRun,
          quietStartHour: s.quietHours.startHour,
          quietEndHour: s.quietHours.endHour,
          helpText: s.helpText,
          authTokenSet: s.authTokenSet,
        }}
        tablesReady={s.configured}
        status={{ ok: status.ok, detail: status.detail }}
      />

      {/* ---------------------------------------------------------------------
          The part this app cannot do for you.
          Every item below is a console setting that this page has no API to
          read, and each one fails silently rather than loudly: an unverified
          number is filtered by carriers, a missing webhook means STOP is never
          recorded, and a mismatched origin means the webhook arrives and is
          rejected. Listing them is the only guard available.
      --------------------------------------------------------------------- */}
      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Still has to happen outside this app
        </h2>
        <p className="mt-2 text-xs text-ink-soft">
          None of this is visible from here — the credentials above can be
          perfect while every one of these is wrong.
        </p>

        <ol className="mt-4 space-y-4 text-sm">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 font-mono text-xs text-ink-faint">1</span>
            <div className="min-w-0">
              <p className="font-medium text-ink">
                Toll-free verification submitted and approved
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                In the Twilio console under Messaging → Toll-free verification.
                Until it is <em>approved</em>, traffic from the number is heavily
                filtered by the carriers and the API still reports every message
                as accepted — the failure looks like "some people didn't get it",
                not like an error. The form asks for an opt-in screenshot, so the
                URL to give it is the consent step at{" "}
                <code className="font-mono text-phosphor-ink">/dashboard/phone</code>.
              </p>
            </div>
          </li>

          <li className="flex items-start gap-3">
            <span className="mt-0.5 font-mono text-xs text-ink-faint">2</span>
            <div className="min-w-0">
              <p className="font-medium text-ink">
                Webhook URL set in <strong>both</strong> places
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                One route handles inbound texts and delivery receipts, but Twilio
                has two separate fields for it — "A message comes in" on the
                number's Messaging configuration, and the status callback URL on
                the number or its messaging service. Set both to:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-wash p-3 text-xs text-phosphor-ink">
                {webhookUrl}
              </pre>
              <p className="mt-2 text-xs text-ink-soft">
                Miss the first and a STOP is never recorded, which is the
                violation with a ten-business-day clock on it. Miss the second
                and the outbox shows everything as sent forever, because nothing
                ever reports back.
              </p>
              <p className="mt-2 text-xs text-ink-soft">
                Paste it with the{" "}
                <code className="font-mono">#rp=ct,5xx&amp;rc=3</code> on the
                end. That tells Twilio to retry when we answer with an error —
                which we do when an opt-out couldn&rsquo;t be saved — and by
                default it doesn&rsquo;t. Twilio leaves the part after{" "}
                <code className="font-mono">#</code> out of the signature, so
                it doesn&rsquo;t affect the check in step 3.
              </p>
            </div>
          </li>

          <li className="flex items-start gap-3">
            <span className="mt-0.5 font-mono text-xs text-ink-faint">3</span>
            <div className="min-w-0">
              <p className="font-medium text-ink">
                <code className="font-mono">NEXT_PUBLIC_SITE_URL</code> matches
                that URL exactly
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                Currently{" "}
                <code className="font-mono text-phosphor-ink">{env.siteUrl}</code>.
                Twilio signs the URL it was configured with, and behind Vercel's
                proxy the incoming request reports an internal host — so the
                route rebuilds the signed URL from this variable instead. Any
                difference at all, including{" "}
                <code className="font-mono">http</code> vs{" "}
                <code className="font-mono">https</code>, a{" "}
                <code className="font-mono">www.</code> prefix, or a trailing
                slash, produces a different HMAC and every webhook is rejected
                with a <strong>403</strong>. Opt-outs stop being recorded and
                nothing in this UI looks broken.
              </p>
            </div>
          </li>

          <li className="flex items-start gap-3">
            <span className="mt-0.5 font-mono text-xs text-ink-faint">4</span>
            <div className="min-w-0">
              <p className="font-medium text-ink">
                Twilio&rsquo;s own STOP / HELP replies match ours
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                Twilio can answer the opt-out keywords itself, before this app
                sees the message. Check what the number (or its messaging
                service&rsquo;s opt-out management) is set to send. If both reply,
                someone who texts HELP gets two answers; if Twilio&rsquo;s wording
                differs from ours, the text and{" "}
                <code className="font-mono">/texts</code> disagree.
              </p>
            </div>
          </li>
        </ol>
      </Card>
    </div>
  );
}
