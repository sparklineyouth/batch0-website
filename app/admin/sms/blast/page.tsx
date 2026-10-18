import Link from "next/link";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { AUDIENCE_SEGMENTS } from "@/lib/email/catalog";
import { MAX_SEGMENTS, smsTransportStatus } from "@/lib/sms/send";
import { getSmsSettings } from "@/lib/sms/settings";
import { CONSENT_COPY } from "@/lib/sms/consent";
import { isSmsAudienceSegment } from "@/lib/sms/policy";
import { formatE164 } from "@/lib/phone";
import { BlastForm, type BlastCohort, type BlastSegmentOption } from "./blast-form";

// The email catalog's segments, narrowed to the ones a program text may go to
// (lib/sms/policy.ts) — same labels, so "accepted" means the same thing in
// both composers.
const SEGMENTS: BlastSegmentOption[] = AUDIENCE_SEGMENTS.flatMap((s) =>
  isSmsAudienceSegment(s.value) ? [{ value: s.value, label: s.label }] : [],
);

export const metadata = {
  title: "SMS campaign · Admin",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export const revalidate = 0;
// A campaign parks one outbox row per recipient through enqueueSms, so a
// few-hundred-person audience is a few hundred inserts. Nothing is sent inside
// the request — the drain does that — but the queueing itself needs room.
export const maxDuration = 60;

export default async function AdminSmsBlastPage() {
  // The section layout and the middleware both gate this route already. Repeated
  // here because a page is its own entry point and "sms.send" is the permission
  // that spends money — the same reason /admin/recovery re-checks.
  await assertPermission("sms.send");

  const admin = createAdminClient();
  const [transport, settings, { data: cohorts }] = await Promise.all([
    // NOT a check on process.env.TWILIO_*. Which credentials are live is a
    // database setting an admin saves at /admin/sms/settings, and every env var
    // on this project is write-only in Vercel — `vercel env pull` returns them
    // as empty strings, so an env check reports "not configured" on a site that
    // is sending fine.
    smsTransportStatus(),
    getSmsSettings(),
    admin.from("cohorts").select("id, name").order("starts_on", { ascending: false }),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          SMS campaign
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Write one program text and queue it to an audience of students who
          turned texts on. Everything is counted in segments before it&apos;s
          sent, because that is what a carrier bills.
        </p>
      </div>

      {transport.ok ? (
        <BlastForm
          segments={SEGMENTS}
          cohorts={(cohorts ?? []) as BlastCohort[]}
          maxSegments={MAX_SEGMENTS}
          fromNumber={settings.fromNumber ? formatE164(settings.fromNumber) : "the sending number"}
          helpText={settings.helpText}
          transportDetail={transport.detail}
          adminTestConsent={CONSENT_COPY.adminTest}
        />
      ) : (
        // No sendable form when the transport can't send. A composer that lets
        // someone write a campaign, resolve an audience, and click send into a
        // dead transport wastes the one thing this page is supposed to protect:
        // their attention on a message that costs money.
        <Card className="mt-8 border-amber-500/40 bg-amber-500/[0.06]">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Texting isn&apos;t sending yet
          </h2>
          <p className="mt-2 text-sm text-ink">{transport.detail}</p>
          <p className="mt-3 text-sm text-ink-soft">
            Nothing is lost by waiting — anything already queued stays in the{" "}
            <Link href="/admin/sms/outbox" className="underline">
              outbox
            </Link>{" "}
            and drains as soon as this is fixed. Credentials, the sending number
            and the pause switch all live at{" "}
            <Link href="/admin/sms/settings" className="underline">
              Settings
            </Link>
            .
          </p>
        </Card>
      )}
    </div>
  );
}
