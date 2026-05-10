/**
 * Centralized env helpers. Returns undefined for optional services so
 * the app keeps working when integrations aren't configured yet.
 */
export const env = {
  siteUrl:
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://sparklineyouth.org",
  contactEmail:
    process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "sparkline.youth@gmail.com",

  // Supabase (required)
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,

  // Stripe (required for payment flow)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,

  // Optional integrations — code that uses them must no-op when unset.
  resendApiKey: process.env.RESEND_API_KEY,
  resendFrom: process.env.RESEND_FROM ?? "SparkLine <noreply@sparklineyouth.org>",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  cronSecret: process.env.CRON_SECRET,

  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  discordGuildId: process.env.DISCORD_GUILD_ID,
  discordRoleStudent: process.env.DISCORD_ROLE_STUDENT,
  discordAnnouncementsWebhook: process.env.DISCORD_ANNOUNCEMENTS_WEBHOOK,
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  // Hex-encoded Ed25519 public key from the Discord developer portal —
  // used to verify Interaction (slash command) requests.
  discordPublicKey: process.env.DISCORD_PUBLIC_KEY,
} as const;

export function ensure(key: keyof typeof env, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}
