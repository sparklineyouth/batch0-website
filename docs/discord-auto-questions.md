# Automatic Discord question replies

Prepared September 14, 2026. The answer policy, provider adapter, worker, durable state interface, and admin controls are implemented locally. The release owner is integrating and verifying the combined release; deployment approval is still pending. This document does not establish that production polling is enabled.

## Behavior and boundaries

The worker polls the configured Batch0 Discord server once per minute through the existing Vercel project. It uses Discord's REST API, not a persistent Gateway connection. A cron schedule is a polling cadence, not an instant-response guarantee. Vercel does not automatically retry failed cron invocations, and duplicate/overlapping invocations must be safe. The deployment plan must support the configured cadence. [Vercel cron operations](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

The bot considers recent ordinary messages and replies that look like questions or requests for help. It skips bot/webhook/system messages, slash commands, quoted or code-only questions, messages from before activation, and messages over ten minutes old. A language model can decline rhetorical chatter, questions already answered in the supplied context, or requests directed to another human. Detection can miss a question. This is not a promise to answer every message, read every channel, or respond immediately.

Each run has a 135-second work budget, at most three generations, and up to 30 channels. Channels rotate by their last polling time. A channel scan covers at most 500 messages; an incomplete backlog is reported instead of jumping its cursor forward. Questions may age out before a busy channel can be fully scanned. The route itself has a 180-second platform limit.

The transport discovers readable text, announcement, voice/stage text channels, and accessible active threads in the configured guild. Permissions still apply: it does not join private threads, widen channel permissions, or reply to locked, archived, or read-only channels. An unreadable channel is not a supported destination. Staff can exclude channel or category IDs; channel exclusions include their threads, and category exclusions include their descendants. An empty exclusion list covers every otherwise eligible channel the bot can access. Ordinary message text also requires Discord's Message Content intent where applicable; REST polling does not bypass that requirement. [Discord message access](https://docs.discord.com/developers/resources/message), [Message Content intent](https://docs.discord.com/developers/events/gateway#message-content-intent)

Replies stay attached to the source message in its original channel. They are labeled **Batch0 AI** and tell readers to verify important details with staff. Mention parsing and reply pings are disabled. Source-message IDs become Discord nonces with `enforce_nonce`; durable database dedupe is also required because Discord's nonce uniqueness window is only a few minutes. [Discord message creation](https://docs.discord.com/developers/resources/message#create-message)

## Context and privacy

The automatic answerer does **not** retrieve private student profiles, applications, payments, refund cases, check-ins, team records, direct messages, private course files, or the dashboard AI's personal history. It receives only the current question and up to three short messages supplied from the **same channel**, plus a fixed public-information prompt. A private Discord channel's own messages remain private channel content; access to that channel is not permission to reuse its content elsewhere.

The latest question is limited to 4,000 UTF-8 bytes and nearby context to about 1,200 bytes. No attachments are opened, links fetched, code executed, or tools offered to the model. API credentials remain transport headers, never prompt content. Messages are untrusted data and cannot change the destination, authorize an account action, or become system instructions.

Durable state keeps source IDs and a source-content hash for dedupe, without storing question text. A generated answer is temporarily saved for delivery, then erased on sent/skipped/uncertain settlement. Unsettled answers expire after one day and are erased at the next successful worker cleanup; downtime or backoff can delay that cleanup. An edited, deleted, inaccessible, or stale source is checked again before delivery and cannot receive a cached answer. Service-only database tables and the locked state RPC protect this ledger from student access.

The approved links include the public program, free starter kit, signed-in course at `/dashboard/course`, personal Events page, and account settings. The bot must not invent current schedules, grants, prizes, sponsors, or completed staff actions. Account, enrollment, payment/refund, and sensitive personal cases go to `hello@batch0.org`; the bot should not request personal details in a channel. A request to reveal private information cannot grant the bot access it does not have.

## Spending and failure behavior

Default owner-funded limits are **$0.25 per UTC day** and **$5 total**, including outstanding reservations. These are operating limits for automatic Discord replies, not student allowances. The feature must not call the dashboard AI's overage billing path or create `user_charges`. The separate decision to spend $0 on advertising is unchanged.

Admins may set $0.01–$1 daily and $0.01–$5 total. Limits below the next reservation leave that request paused. There is also a maximum of 100 model claims per day and a 60-second cooldown per person and per channel. Pausing or re-enabling does not reset spend or dedupe. Enabling after a pause establishes a new activation cutoff.

The fixed model is `claude-haiku-4-5-20251001`, with at most 700 output tokens. Current API pricing is $1 per million input tokens and $5 per million output tokens. A 2,000-input/700-output response costs $0.0055 before any applicable taxes. Pricing must be reviewed before changing the model or these limits. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Before generation, the state layer reserves **16,000 microUSD ($0.016)** atomically. The adapter calls the free token-counting endpoint with the exact intended model input. Counts over **10,000** or invalid counts stop without generation. Anthropic documents counts as estimates; the 10,000 threshold leaves room before the **12,000 actual-input** settlement ceiling. Together with 700 output tokens, that ceiling costs $0.0155. Actual usage, not the estimate, is used for settlement. [Token-counting limits](https://platform.claude.com/docs/en/build-with-claude/token-counting)

Model requests use a 20-second timeout and **no automatic retries**. A timeout can leave an uncertain provider bill, so the state layer retains the full reservation. Unexpected models, invalid usage, input above 12,000, output above 700, or unexpected cache usage throw instead of publishing an unaccounted answer. Inspect an anomalous usage report before allowing further work; the provider's billing record remains authoritative. Do not mark uncertain work as zero-cost or silently regenerate it. The default SDK would otherwise retry some failures. [Anthropic SDK retry and timeout behavior](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)

A valid model response can still decline to answer. Invalid JSON, empty answers, or an incomplete completion remain silent, but known generation cost is retained. A saved generation may be delivered later without another model call if sending has not started, or Discord explicitly rejected it for rate limiting, or a local request limit prevented the request. An ambiguous send error or lost response is never resent; a later run may only reconcile a verifiable existing bot reply. Budget exhaustion, disabled configuration, missing permissions, provider rate limits, and storage failures can all result in no reply. A global Discord rate limit records durable backoff for later runs.

## Admin operation and release checks

Controls live under **Admin → Discord → Automatic question answers** (`/admin/discord`) and require `discord.manage`. Save actions are rejected outside the production deployment. The release owner is still verifying the integrated interface and database migration; check deployment status before enabling it.

1. Select **Check connection**, which is read-only. Confirm the configured guild, bot identity, message permissions, Message Content intent, AI key, scheduled-job secret, and available storage. Review **Excluded channel or category IDs** before enabling; a discovered channel is not automatically an appropriate destination. Enabling explicitly requests the limited Message Content intent if absent, preserving existing application flags; Discord may require a Developer Portal change instead.
2. Set **Daily AI limit (USD)** and **Total AI limit (USD)**, then **Save limits and exclusions**. Confirm usage includes pending reservations. Pausing or redeploying must not erase spend, delivery records, or source-message dedupe.
3. Review the activation timestamp and polling cursors. Enabling or resuming must not trigger replies across historical conversations. The ten-minute freshness window intentionally leaves older questions for people to handle.
4. Select **Enable automatic answers** only after durable state, cron authentication, and duplicate-run protection pass verification. The main Discord integration must also be enabled. `/api/cron/discord-auto-questions` rejects requests without the scheduled-job bearer secret; its authenticated `?check=1` mode only checks prerequisites. Preview cron runs cannot scan messages, spend, or send.
5. Inspect a controlled fresh question, its single labeled reply, source linkage, usage settlement, and cursor advancement. Test a duplicate invocation and a pause without creating a second paid generation. Verify a non-question and a bot message remain unanswered.
6. Select **Pause automatic answers** when needed. The main Discord switch also pauses the responder. The state transaction rechecks switches before claiming paid work and starting a send; the worker also checks current scope before delivery. Preserve queued/delivery state for diagnosis.

**Cohort reminders and Discord announcements remain drafts.** Authorization for question replies does not authorize bulk promotion, scheduled reminders, new DMs, or turning on the event editor's Notify option.

## Validation

`lib/discord-auto-ai.test.ts` drives the real Anthropic SDK through an injected mock fetch. It checks matching count/generation inputs, fixed model and bounds, credential separation, token-estimate gates, actual-usage differences, malformed usage, structured answer suppression, timeout without retry, and cancellation before paid work. `lib/discord-auto-policy.test.ts` covers candidate filtering, age/scope rules, input size, and safe labeled output. These tests make no live provider calls and spend no money.

Run `npm test`, `npm run test:discord-db`, `npx tsc --noEmit`, and `npm run build` on the combined release. The database suite executes the actual migration/RPC with local PostgreSQL through PGlite, including budget reservation, fencing, dedupe, and uncertain-send settlement. Tests make no live sends. Record the final combined checks and production activation result when deployed; do not substitute this document for those results.
