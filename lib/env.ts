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

  // Daily (live video — webinars and 1:1 calls). Optional: every helper in
  // lib/daily.ts no-ops when unset, so an environment without a key degrades
  // to "hosting unavailable" and the rest of the site is unaffected.
  //
  // dailyApiKey is server-only and must NEVER gain a NEXT_PUBLIC_ prefix. It
  // can create rooms and mint owner tokens for ANY room on the domain, so in
  // the browser it is a key to every call the site will ever host — including
  // 1:1s it was not issued for.
  dailyApiKey: process.env.DAILY_API_KEY,
  // The domain rooms live on, e.g. "batch0.daily.co". Public by design: it
  // appears in every room URL the client connects to. On its own it grants
  // nothing, because rooms are private and joining needs a minted token.
  dailyDomain: process.env.NEXT_PUBLIC_DAILY_DOMAIN,
  // Cloud recording is a PAID Daily feature — a free plan rejects room and
  // token creation outright if `enable_recording: "cloud"` is set. Off by
  // default so webinars work on any plan; set DAILY_ENABLE_RECORDING=true once
  // the account is on a plan that includes recording, and hosts can record.
  dailyRecording: process.env.DAILY_ENABLE_RECORDING === "true",
  // Large-call optimization (`experimental_optimize_large_calls`) is only
  // needed above 50 participants, and it opts the room into Daily's paid-scale
  // infrastructure — which an account WITHOUT a payment method rejects with
  // "account is missing a payment method", failing the whole webinar. batch0's
  // webinars are far smaller than 50, so this is OFF by default and every
  // webinar works on any plan. Set DAILY_LARGE_CALLS=true only when the account
  // has a card on file AND a webinar genuinely expects 50+ viewers. Same shape
  // as dailyRecording: a paid feature, opt-in, defaulting to "works anywhere".
  dailyLargeCalls: process.env.DAILY_LARGE_CALLS === "true",

  // ---------------------------------------------------------------------
  // batch0 Live — the built-in webinar provider (lib/live-rooms.ts).
  // ---------------------------------------------------------------------
  //
  // Which provider hosted events and 1:1 calls actually run on.
  //
  // Defaults to "builtin", and that default is load-bearing rather than a
  // preference: the Daily account this project was wired to cannot start a
  // media session at all. Every join — including into a bare public room with
  // no properties set — is refused with `account-missing-payment-method`,
  // which is an account-level block no code here can clear. Daily's REST API
  // still answers perfectly, which is exactly why it looked healthy for so
  // long (see scripts/daily-doctor.mts, and scripts/webinar-e2e.mts for the
  // check that catches it).
  //
  // Set LIVE_PROVIDER=daily to go back, once that account has a card on file.
  // Nothing about the Daily path was removed.
  liveProvider:
    process.env.LIVE_PROVIDER === "daily" ? ("daily" as const) : ("builtin" as const),

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
