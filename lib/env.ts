/**
 * Centralized env helpers. Returns undefined for optional services so
 * the app keeps working when integrations aren't configured yet.
 */
export const env = {
  siteUrl:
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://batch0.org",
  contactEmail:
    process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "hello@batch0.org",

  // Supabase (required)
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,

  // Stripe (required for payment flow)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,

  // Optional integrations — code that uses them must no-op when unset.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  cronSecret: process.env.CRON_SECRET,

  // Email (Resend). Optional — the app falls back to a console-log stub
  // when these aren't set, so local dev keeps working without a key.
  resendApiKey: process.env.RESEND_API_KEY,
  // The verified `From:` address Resend sends as. Must be on a domain
  // verified in the Resend dashboard — batch0.org is, and its DKIM
  // (resend._domainkey), SPF and the send.batch0.org MX are all published.
  // The default is the real address rather than onboarding@resend.dev so a
  // missing env var degrades to "correct sender" instead of "email from a
  // stranger's domain".
  resendFrom: process.env.RESEND_FROM ?? "batch0 <hello@batch0.org>",
  // Svix signing secret from the Resend webhooks dashboard. Looks like
  // "whsec_xxx". When unset, /api/resend/webhook returns 400 — we
  // refuse to ingest unsigned events because the table is service-role
  // writable and an open endpoint would be a denial-of-service vector.
  resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET,

  // ---------------------------------------------------------------------
  // batch0 Live — the built-in webinar provider (lib/live-rooms.ts).
  // ---------------------------------------------------------------------
  //
  // The only provider hosted events and 1:1 calls run on (docs/batch0-live.md).

  // Secret that channel names and host proofs are derived from. Never sent to
  // a browser; only HMACs of it are, and only to the participant they belong
  // to. Falls back to the service-role key so batch0 Live needs NO new
  // environment variable to be secure — the fallback is a one-way HMAC input,
  // never transmitted. Set LIVE_ROOM_SECRET to rotate every room key without
  // touching Supabase credentials.
  liveRoomSecret:
    process.env.LIVE_ROOM_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY,

  // Optional TURN relay, for viewers whose network refuses a direct peer
  // connection (symmetric NAT, some school and corporate firewalls). STUN
  // alone covers the large majority of home networks, so this stays optional
  // in the usual shape: unset means "no relay", not "broken".
  //
  // Comma-separated, e.g.
  //   LIVE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
  // Server-only: TURN credentials are handed to the browser per join by
  // lib/live-rooms.ts, never inlined into the bundle.
  liveTurnUrls: process.env.LIVE_TURN_URLS,
  liveTurnUsername: process.env.LIVE_TURN_USERNAME,
  liveTurnCredential: process.env.LIVE_TURN_CREDENTIAL,

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
