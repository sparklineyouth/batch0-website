import Link from "next/link";
import { ArrowRight, MessageSquare } from "lucide-react";
import { getUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { isReachableByTollFree, normalizeToE164 } from "@/lib/phone";
import { canOptInAtAge } from "@/lib/sms/policy";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";

/**
 * "Turn on text updates?" — the nudge that turns an empty consent table into
 * an opted-in one, once texting is actually running.
 *
 * Mounted on app/dashboard/page.tsx. Self-contained on purpose: `getUser()` is
 * request-cached, the settings row is behind a 30-second process cache, and
 * the two other reads are point lookups on indexed columns.
 *
 * The cases it stays silent for matter more than the one it speaks in:
 *
 *   * TEXTING ISN'T LIVE. Until a provider number and credentials are saved,
 *     a banner asking for permission to text is a promise of texts we cannot
 *     send. The opt-in itself still exists at /dashboard/phone — the carrier
 *     reviews it before approving the number — but nothing advertises it.
 *   * The tables are missing — 0106 isn't applied yet. A dashboard must not
 *     break because a migration is a few minutes behind a deploy.
 *   * Already consented, under 13, a number we couldn't text anyway, or an
 *     applicant who isn't in the program yet — nothing worth asking.
 *   * OPTED OUT. Someone who replied STOP and then gets a banner asking them
 *     to turn texts back on has been re-marketed to by the product, which is
 *     the harm the opt-out exists to prevent.
 */
export async function SmsConsentPrompt() {
  const user = await getUser();
  if (!user) return null;

  const settings = await getSmsSettings();
  if (!settings.configured || settings.readError || !hasCredentials(settings)) return null;

  const admin = createAdminClient();
  const { data: app, error } = await admin
    .from("applications")
    .select("status, phone, age")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !app) return null;

  // Only people the program actually needs to reach in a hurry. An applicant
  // still waiting on a decision has no session to be told is starting, and
  // asking them for texting permission first is the kind of prompt that trains
  // people to ignore prompts.
  if (!REACHABLE_STATUSES.has(String(app.status))) return null;
  if (!canOptInAtAge((app.age as number | null) ?? null)) return null;

  const phone = normalizeToE164((app.phone as string | null) ?? null);
  if (phone && !isReachableByTollFree(phone)) return null;

  if (phone) {
    const { data: consent, error: consentError } = await admin
      .from("messaging_consent")
      .select("transactional, opted_out_at")
      .eq("phone_e164", phone)
      .maybeSingle();
    if (consentError) {
      if (!isMissingSchemaError(consentError)) {
        console.error("[sms-consent-prompt] consent read failed", consentError.message);
      }
      return null;
    }
    if (consent?.opted_out_at || consent?.transactional) return null;
  }

  return (
    <section className="mt-8">
      <Link
        href="/dashboard/phone"
        prefetch={false}
        className="flex items-center gap-3 border-y border-line py-4 hover:bg-wash"
      >
        <MessageSquare className="h-4 w-4 shrink-0 text-phosphor-ink" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-ink">Turn on text updates?</p>
          <p className="mt-0.5 text-xs text-ink-faint">
            {phone
              ? "Session reminders and schedule changes by text, as well as email. Optional — STOP works any time."
              : "Add a mobile number and you can get session reminders and schedule changes by text. Optional."}
          </p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint" />
      </Link>
    </section>
  );
}

/** Statuses where a time-sensitive text is a real thing we'd send. */
const REACHABLE_STATUSES = new Set(["accepted", "paid", "enrolled"]);
