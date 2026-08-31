import { getPublicEmailSettings } from "@/lib/email/settings";
import { env } from "@/lib/env";
import { EmailSettingsForm } from "./settings-form";

export const metadata = { title: "Email settings · Admin" };
export const dynamic = "force-dynamic";

export default async function EmailSettingsPage() {
  // getPublicEmailSettings drops the decrypted SMTP password before this
  // object exists — the secret never reaches a component that could serialize
  // it into the page.
  const s = await getPublicEmailSettings();

  return (
    <EmailSettingsForm
      initial={{
        transport: s.transport,
        fromName: s.fromName,
        fromEmail: s.fromEmail,
        replyTo: s.replyTo ?? "",
        smtpHost: s.smtpHost ?? "",
        smtpPort: s.smtpPort ?? 587,
        smtpSecure: s.smtpSecure,
        smtpUser: s.smtpUser,
        smtpPassword: "",
        automationsPaused: s.automationsPaused,
        maxSendsPerRun: s.maxSendsPerRun,
        smtpPasswordSet: s.smtpPasswordSet,
      }}
      resendConfigured={Boolean(env.resendApiKey)}
      tablesReady={s.configured}
    />
  );
}
