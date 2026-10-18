import type { SmsSettings } from "@/lib/sms/settings";
import { twilioProvider } from "@/lib/sms/providers/twilio";

/**
 * One interface, N providers.
 *
 * The reason this abstraction exists on day one rather than being extracted
 * later: the choice between a local 10DLC number and a verified toll-free one —
 * and between Twilio and Telnyx, which is about $99/year at this volume — is a
 * decision that gets made in a vendor console, under time pressure, possibly
 * after a registration rejection. It should not also be a code change. Provider
 * and credentials live in `sms_settings`, so switching is a settings save.
 *
 * Kept deliberately small. Everything a provider is allowed to know about is a
 * destination, a body, and a callback URL; consent, quiet hours, segmentation
 * and retries all live above this line so they cannot diverge per provider.
 */

export type SendArgs = {
  to: string;
  from: string;
  body: string;
  /** Where the provider should post delivery receipts. Omitted in dev. */
  statusCallback?: string;
};

export type ProviderResult =
  | { ok: true; providerId: string; status?: string }
  | { ok: false; reason: string; errorCode?: string; retryable: boolean };

export type SmsProvider = {
  name: "twilio" | "telnyx";
  send(args: SendArgs, s: SmsSettings): Promise<ProviderResult>;
  /**
   * Verify an inbound webhook actually came from the provider.
   *
   * Not optional and not a nice-to-have: the handler below it writes opt-outs,
   * so an unauthenticated endpoint is a way for anyone on the internet to
   * silence our messaging to any number they choose — and, by replaying a
   * delivery receipt, to mark unsent messages as delivered.
   */
  verifyWebhook(args: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
    s: SmsSettings;
  }): boolean;
};

export function providerFor(s: SmsSettings): SmsProvider {
  switch (s.provider) {
    case "twilio":
      return twilioProvider;
    case "telnyx":
      // Intentionally not stubbed with a throwing object. The settings column
      // accepts 'telnyx' so the migration doesn't have to change when it is
      // added, but a half-implemented provider that fails at send time is worse
      // than one that cannot be selected — so the settings form offers only
      // Twilio today, and this line is what reminds the next person to add both.
      throw new Error(
        "Telnyx is not implemented yet. Add lib/sms/providers/telnyx.ts and offer it in the settings form.",
      );
    default:
      return twilioProvider;
  }
}
