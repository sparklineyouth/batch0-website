import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { Card } from "@/components/ui/card";
import { normalizeToE164 } from "@/lib/phone";
import { CONSENT_COPY } from "@/lib/sms/consent";
import { canOptInAtAge } from "@/lib/sms/policy";
import { OPT_OUTS_THE_FORM_CANNOT_LIFT } from "@/lib/sms/consent-rules";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";
import { PhoneForm, type ConsentSnapshot, type TextsState } from "./phone-form";

export const metadata = { title: "Your phone number · batch0" };

/**
 * Texting's state for this student's number.
 *
 * Service-role, because 0106 revoked `messaging_consent` from `authenticated`
 * outright: the table is keyed on a NUMBER and one number can sit behind more
 * than one account, so there is no row-level predicate that honestly says
 * "yours". The read is instead hard-scoped to the number already on the
 * caller's own application, which is the same guarantee reached another way.
 *
 * A missing table means 0106 hasn't run yet. Collecting a number still has to
 * work in that window, so the page then shows the number field alone — no
 * texting checkbox, because there would be nowhere to record the answer.
 */
async function textsState(phone: string | null, age: number | null): Promise<TextsState> {
  const settings = await getSmsSettings();
  if (!settings.configured) return { kind: "unavailable" };
  if (!canOptInAtAge(age)) return { kind: "under_age" };

  // Whether a text could actually leave the building today. The opt-in is
  // shown either way — the carrier that approves our number reviews this page
  // before a single text can go out (docs/sms.md, step 1) — but the page says
  // so, rather than implying texts are already arriving.
  const live = hasCredentials(settings) && !settings.readError;

  const e164 = normalizeToE164(phone);
  if (!e164) return { kind: "ready", live, savedE164: null, consent: null };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messaging_consent")
    .select("transactional, opted_out_at, opted_out_source, last_opted_in_at")
    .eq("phone_e164", e164)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { kind: "unavailable" };
    console.error("[dashboard/phone] consent read failed", error.message);
    return { kind: "ready", live, savedE164: e164, consent: null };
  }
  const consent: ConsentSnapshot | null = data
    ? {
        transactional: Boolean(data.transactional),
        optedOutAt: (data.opted_out_at as string | null) ?? null,
        // Whether ticking the box here can undo the opt-out. A STOP, a carrier
        // block, or a request someone made through support is not the form's to
        // lift (lib/sms/consent-rules.ts), so the page says how instead.
        liftableHere: !OPT_OUTS_THE_FORM_CANNOT_LIFT.has(
          (data.opted_out_source as string | null) ?? "",
        ),
        lastOptedInAt: (data.last_opted_in_at as string | null) ?? null,
      }
    : null;
  return { kind: "ready", live, savedE164: e164, consent };
}

/**
 * Where the "we need your phone number" email lands accepted students who
 * applied before the form asked for one — and, since 0106, the program's only
 * SMS opt-in screen. Reading their own application is fine under RLS; the write
 * goes through the service-role client in the action (see ./actions), because a
 * student can't self-update a non-draft row.
 *
 * This page doubles as the artifact submitted for toll-free verification, so
 * everything a reviewer looks for is rendered here rather than linked to: the
 * brand, what the texts are, message frequency, that rates may apply, how to
 * stop, and both policies. The disclosure comes from CONSENT_COPY so the words
 * shown are literally the words the ledger stores.
 */
export default async function PhonePage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: app } = await supabase
    .from("applications")
    .select("id, phone, age")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentPhone = (app?.phone as string | null) ?? "";
  const texts = app
    ? await textsState(currentPhone || null, (app.age as number | null) ?? null)
    : ({ kind: "unavailable" } as const);

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-ink">
        Your phone number
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        We collect a phone number for everyone in the program so we can reach
        you — by call or text — about kickoff logistics and anything
        time-sensitive. Program messages only: we never send marketing texts,
        and we never share or sell your number. Reply STOP to any text to opt
        out; we'll email you instead. See our{" "}
        <Link href="/privacy" className="text-phosphor-ink underline">
          Privacy Policy
        </Link>
        .
      </p>

      <Card className="mt-6 p-5 sm:p-6">
        {app ? (
          <>
            {currentPhone && (
              <p className="text-sm text-ink-soft">
                We currently have{" "}
                <span className="font-medium text-ink">{currentPhone}</span> on
                file. You can update it below.
              </p>
            )}
            <PhoneForm
              initialPhone={currentPhone}
              texts={texts}
              consentCopy={CONSENT_COPY.studentTransactional}
            />
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            We couldn't find an application on your account, so there's nothing
            to attach a number to yet.{" "}
            <Link href="/apply" className="text-phosphor-ink underline">
              Apply here
            </Link>{" "}
            and the form will ask for your phone number.
          </p>
        )}
      </Card>

      {texts.kind === "ready" && (
        // The plain-English version of what the checkbox commits us to.
        // Redundant with the disclosure by design — a reviewer reads this, and
        // a student who skimmed the sentence reads this.
        <dl className="mt-6 space-y-3 text-xs text-ink-soft">
          <div>
            <dt className="font-mono uppercase tracking-wider text-ink-faint">
              Who texts you
            </dt>
            <dd className="mt-0.5">
              batch0 (Sparkline Youth LLC), from one US toll-free number. Never a
              partner, never an advertiser — we don't share or sell your number.
            </dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-wider text-ink-faint">
              How often
            </dt>
            <dd className="mt-0.5">
              Message frequency varies with the cohort calendar. Msg &amp; data
              rates may apply.
            </dd>
          </div>
          <div>
            <dt className="font-mono uppercase tracking-wider text-ink-faint">
              How to stop
            </dt>
            <dd className="mt-0.5">
              Reply STOP to any message, or turn texts off above. Reply HELP for
              help, or email{" "}
              <a
                href="mailto:hello@batch0.org"
                className="text-phosphor-ink underline"
              >
                hello@batch0.org
              </a>
              . Full terms:{" "}
              <Link href="/messages" className="text-phosphor-ink underline">
                Text messages
              </Link>
              .
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
