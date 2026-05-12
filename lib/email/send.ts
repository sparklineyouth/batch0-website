type EmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type EmailResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Email send is disabled. The project doesn't ship with a Resend (or any
 * other) provider configured, so this is a permanent no-op stub. Call
 * sites already handle `ok: false`, so leaving the signature in place
 * keeps the surrounding flows compiling and running.
 *
 * If you reintroduce transactional email later, wire the provider call
 * up here. The `EmailResult` contract is what callers expect.
 */
export async function sendEmail(args: EmailArgs): Promise<EmailResult> {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[email] disabled; would have sent to ${
        Array.isArray(args.to) ? args.to.join(",") : args.to
      } subject="${args.subject}"`,
    );
  }
  return { ok: false, reason: "disabled" };
}
