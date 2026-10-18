-- ============================================================================
-- 0106 — Texting: consent, an outbox, settings, and delivery events.
--
-- Why this exists
-- ---------------
-- Email needed no permission. SMS does, and that difference is the whole shape
-- of this migration: the sending machinery is the easy half, and it is almost
-- entirely a copy of what 0052 already built for email. The half that has no
-- email analogue is proving, message by message, that the person on the other
-- end asked to be texted — because an unwanted text carries $500–$1,500 of
-- statutory damages under the TCPA where an unwanted email carries none, and
-- because the carrier that approves our sending number asks to see the opt-in
-- before it approves anything at all.
--
-- So consent here is not a boolean on a profile. It is:
--
--   * `messaging_consent`     — the current answer for a NUMBER, which is what
--                               a carrier and a court both reason about.
--   * `messaging_consent_log` — append-only, storing the exact sentence the
--                               person was shown. Not a version pointer to copy
--                               that lives in a React file and will be edited
--                               next month; the rendered string itself, because
--                               the evidence has to survive the code changing.
--
-- What the app sends today: program texts, nothing else
-- -----------------------------------------------------
-- The privacy policy (#333, lib/sms-consent-policy.test.ts) promises we do not
-- send promotional or marketing texts, and docs/sms-marketing-opt-in.md lists
-- what would have to exist first — guardian confirmation for under-18s among
-- it. So the application only ever records and sends `transactional` (program
-- logistics) consent and messages: lib/sms/policy.ts holds that switch, and
-- lib/sms-policy.test.ts keeps it off.
--
-- The schema still carries `purpose` and `party` as first-class columns, and
-- still refuses promotional consent on a student's number outright
-- (messaging_consent_no_promo_to_students). That is not a feature this file
-- turns on; it is the floor any future marketing path has to build on, written
-- into the database now so that path can never start by texting a minor.
--
-- What this does NOT touch
-- ------------------------
-- Nothing that exists today. Every object below is new and empty until someone
-- opts in. In particular `applications` is untouched: the app normalizes the
-- `phone` already on file with lib/phone.ts at read time rather than keeping a
-- second, stored copy — a stored copy on `applications` would be writable by
-- the student while their row is a draft (the "applications self update
-- draft" policy is row-scoped, not column-scoped, and `authenticated` holds
-- UPDATE on the table), and a number on file was never consent anyway.
--
-- Until an admin saves provider credentials at /admin/sms/settings, nothing
-- here sends: `sms_settings` is seeded with no credentials, and both the
-- transport and the drain refuse to send without them (docs/sms.md).
--
-- Run in Supabase SQL Editor, or `npm run db:migrate -- --apply`.
-- Idempotent / safe to re-run. Assumes 0001..0102 are applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Consent — current state, keyed by NUMBER
--
-- Keyed on the number rather than the user because that is the unit every rule
-- upstream of us uses. A carrier suppresses a number. "STOP" arrives from a
-- number and carries no user id. A recycled number reaches a different person
-- than the one who opted in. And one number can legitimately sit behind more
-- than one account (siblings sharing a phone), where a per-user flag would let
-- one sibling's opt-out be silently undone by the other's.
--
-- `user_id` is therefore "the account this number was collected through", not
-- an owner, and it is nullable: an inbound STOP from a number we have never
-- seen still has to be recorded and honoured.
--
-- Two purposes, not one flag:
--   transactional — program logistics someone asked for (a session starting, a
--                   schedule change, a deadline). The only purpose the app
--                   records or sends today.
--   promotional   — anything selling or up-selling the program. Never written
--                   by the app (see the header), and refused on a student's
--                   number by the check constraint below in any case.
-- ---------------------------------------------------------------------------
create table if not exists public.messaging_consent (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- The account this number arrived through. Not an ownership claim.
  user_id uuid references public.profiles(id) on delete set null,
  -- Which side of the minor-consent line this number sits on.
  party text not null check (party in ('student', 'parent', 'unknown')),
  transactional boolean not null default false,
  promotional boolean not null default false,
  -- Set the moment an opt-out arrives, and cleared only by an explicit new
  -- opt-in that is entitled to clear it (lib/sms/consent-rules.ts). While it is
  -- non-null the number is suppressed for EVERY purpose regardless of the two
  -- flags above — that is what makes the suppression check a single `is null`
  -- test at the transport.
  opted_out_at timestamptz,
  opted_out_source text,
  first_opted_in_at timestamptz,
  last_opted_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A student's number may never carry promotional consent. Belt and braces
  -- against a future call site that means well and gets the party wrong: the
  -- write fails loudly here instead of producing a marketing text to a 15-year-
  -- old, which is the failure mode with actual damages attached.
  constraint messaging_consent_no_promo_to_students
    check (not (promotional and party = 'student'))
);

create index if not exists messaging_consent_user_idx
  on public.messaging_consent (user_id) where user_id is not null;
-- The audience builder's hot path: "which of these numbers may I text?"
create index if not exists messaging_consent_sendable_idx
  on public.messaging_consent (phone_e164) where opted_out_at is null;

-- ---------------------------------------------------------------------------
-- 2. Consent ledger — append-only
--
-- The affirmative defence in 47 USC 227(c)(5)(C) is only available to someone
-- who can show the procedures existed. That means the evidence has to be
-- immutable and has to include the words the person actually read.
--
-- `consent_text` is therefore the fully rendered sentence, snapshotted at the
-- moment of the click. It is the single most important column in this
-- migration and the one a lawyer will ask for.
-- ---------------------------------------------------------------------------
create table if not exists public.messaging_consent_log (
  id bigint generated always as identity primary key,
  phone_e164 text not null,
  -- `on delete set null` here is load-bearing AND it collides with the
  -- append-only trigger below unless that trigger is written to expect it.
  --
  -- The referential action is implemented as an UPDATE. A trigger that refuses
  -- every UPDATE therefore turns "delete this student's account" into a raise
  -- from a table nobody was thinking about — including through
  -- deleteUserAccount, and not discoverable until the first deletion request.
  -- `on delete no action` is not the fix either: that makes the profile
  -- undeletable instead. So the trigger permits exactly this one transition and
  -- nothing else — see messaging_consent_log_is_append_only.
  user_id uuid references public.profiles(id) on delete set null,
  party text not null check (party in ('student', 'parent', 'unknown')),
  action text not null check (action in ('grant', 'revoke')),
  -- Which purposes this action covered, e.g. '{transactional}'. A revoke covers
  -- everything and records both.
  purposes text[] not null default '{}'::text[],
  -- The EXACT string shown to the person. Null only for a revoke, where the
  -- evidence is the inbound message body or the admin's note instead.
  consent_text text,
  -- 'dashboard_phone' | 'sms_stop' | 'sms_start' | 'provider_21610' | 'admin'
  source text not null,
  source_url text,
  -- Both nullable: an inbound STOP has neither, and a fabricated value would be
  -- worse evidence than an honest absence.
  ip text,
  user_agent text,
  -- For a revoke arriving by text, the message that caused it; for one an
  -- admin recorded, what they were told and where.
  inbound_body text,
  created_at timestamptz not null default now()
);

create index if not exists messaging_consent_log_phone_idx
  on public.messaging_consent_log (phone_e164, created_at desc);
create index if not exists messaging_consent_log_user_idx
  on public.messaging_consent_log (user_id, created_at desc);

-- Append-only, enforced rather than documented. Revoking UPDATE and DELETE from
-- service_role would break nothing today, but the trigger is what survives a
-- future migration that hands the table back out: a ledger you can edit is not
-- evidence, and the failure is silent unless something refuses.
create or replace function public.messaging_consent_log_is_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Exactly ONE mutation is allowed: the user_id FK's ON DELETE SET NULL firing
  -- because the profile it pointed at was deleted. Everything that constitutes
  -- the evidence — the number, the party, the action, the purposes, the rendered
  -- consent sentence, the source, the IP, the user agent, the timestamp — must
  -- come through byte-identical, so an UPDATE dressed up as a profile deletion
  -- still cannot rewrite what somebody agreed to.
  if tg_op = 'UPDATE'
     and old.user_id is not null
     and new.user_id is null
     and new.id = old.id
     and new.phone_e164 = old.phone_e164
     and new.party = old.party
     and new.action = old.action
     and new.purposes = old.purposes
     and new.consent_text is not distinct from old.consent_text
     and new.source = old.source
     and new.source_url is not distinct from old.source_url
     and new.ip is not distinct from old.ip
     and new.user_agent is not distinct from old.user_agent
     and new.inbound_body is not distinct from old.inbound_body
     and new.created_at = old.created_at
  then
    return new;
  end if;

  raise exception 'messaging_consent_log is append-only (attempted %)', tg_op;
end $$;

-- A trigger function can't be called through PostgREST, but Supabase's default
-- privileges hand EXECUTE on every new function to anon and authenticated, and
-- there is no reason for either to hold it.
revoke all on function public.messaging_consent_log_is_append_only() from public, anon, authenticated;

drop trigger if exists messaging_consent_log_no_update on public.messaging_consent_log;
create trigger messaging_consent_log_no_update
  before update or delete on public.messaging_consent_log
  for each row execute function public.messaging_consent_log_is_append_only();

-- ---------------------------------------------------------------------------
-- 3. Outbox
--
-- Deliberately a near-copy of `email_outbox` (0052), including the status
-- vocabulary and the dedupe key, so the two drains can be read side by side
-- and a fix to one is an obvious fix to the other. Three columns are new, and
-- each is new for a reason email does not have:
--
--   segments      — SMS bills per 160-character GSM-7 segment (70 on UCS-2, the
--                   moment one emoji appears). A blast's cost is knowable
--                   before it is sent, and only if we count first.
--   purpose       — checked against consent at the transport, not here, because
--                   consent can be revoked between enqueue and send.
--   send_after    — inherited, but now also carries the quiet-hours shift: a
--                   message composed at 11pm is queued for 9am local, not sent.
--
-- The dedupe index is a plain unique index, not a partial one. 0102 had to
-- replace email_outbox's partial index because `on conflict (dedupe_key)` can't
-- infer a partial one; nothing here uses on conflict today, but starting with
-- the shape that works costs nothing (unique still allows any number of nulls).
-- ---------------------------------------------------------------------------
create table if not exists public.sms_outbox (
  id uuid primary key default gen_random_uuid(),
  to_phone text not null check (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  to_name text,
  -- The profile behind the number when there is one, so the outbox can name a
  -- person.
  user_id uuid references public.profiles(id) on delete set null,
  party text not null default 'unknown'
    check (party in ('student', 'parent', 'unknown')),
  purpose text not null check (purpose in ('transactional', 'promotional')),
  body text not null,
  segments integer not null default 1 check (segments >= 1),
  -- What this send was, e.g. 'sms.campaign'. Mirrors the template-key tagging
  -- lib/email/send.ts does on the Resend payload.
  template_key text,
  -- Set when a campaign enqueued this row, so a blast can be reported on and
  -- cancelled as a unit. A plain uuid rather than a foreign key, like
  -- email_outbox's automation ids: an outbox row is a record of a send and must
  -- outlive whatever produced it.
  campaign_id uuid,
  send_after timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'canceled', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  -- The provider's message SID. Joins this row to its delivery receipts.
  provider_id text,
  -- Idempotency key, so a retried cron, a double-clicked send and a webhook
  -- redelivery all collapse into one text.
  dedupe_key text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_outbox_dedupe_key_idx
  on public.sms_outbox (dedupe_key);
-- The drainer's hot path: "what is due?"
create index if not exists sms_outbox_due_idx
  on public.sms_outbox (send_after) where status = 'pending';
create index if not exists sms_outbox_status_idx
  on public.sms_outbox (status, created_at desc);
create index if not exists sms_outbox_recipient_idx
  on public.sms_outbox (to_phone, created_at desc);
create index if not exists sms_outbox_campaign_idx
  on public.sms_outbox (campaign_id, created_at desc) where campaign_id is not null;
create index if not exists sms_outbox_provider_idx
  on public.sms_outbox (provider_id) where provider_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Campaigns
--
-- A blast needs a name and a row of its own so "what did we send on the 14th,
-- to whom, and what did it cost" is answerable without grouping the outbox by
-- a heuristic.
--
-- `client_key` is the composer's per-draft idempotency key. Unique, so two
-- submits of one draft land on one campaign row — and therefore on the same
-- `campaign:<id>:<phone>` dedupe keys — even when they race. Without the index
-- that could only be a read-then-insert, which two clicks a few milliseconds
-- apart can both win.
-- ---------------------------------------------------------------------------
create table if not exists public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  client_key text,
  name text not null,
  body text not null,
  purpose text not null check (purpose in ('transactional', 'promotional')),
  -- The audience spec this was resolved from, kept verbatim so the send can be
  -- explained later even after the segment definitions change.
  audience jsonb not null default '{}'::jsonb,
  segments_per_message integer not null default 1,
  recipients integer not null default 0,
  -- Denormalized counters, recounted from the outbox by the drain. Cheap to
  -- read on a list page; the outbox stays the source of truth.
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'done', 'canceled')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_campaigns_client_key_idx
  on public.sms_campaigns (client_key);
create index if not exists sms_campaigns_created_idx
  on public.sms_campaigns (created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Delivery + inbound events
--
-- Keyed on the provider's own id so ingest is idempotent against retries
-- without any application logic — the same trick `email_events.svix_id` plays
-- in 0024. A provider that redelivers a webhook five times writes one row.
-- ---------------------------------------------------------------------------
create table if not exists public.sms_events (
  -- provider SID + status, because one message emits several receipts
  -- (queued → sent → delivered) all carrying the same SID.
  event_key text primary key,
  provider_id text not null,
  outbox_id uuid references public.sms_outbox(id) on delete set null,
  phone_e164 text,
  direction text not null default 'outbound'
    check (direction in ('outbound', 'inbound')),
  -- Provider status verbatim: queued|sent|delivered|undelivered|failed|received
  status text,
  -- Carrier error code (Twilio 30003 "unreachable", 30007 "carrier violation",
  -- 21610 "unsubscribed"). The closest SMS has to a bounce classification, and
  -- worth keeping raw rather than mapped.
  error_code text,
  body text,
  created_at timestamptz not null default now()
);

create index if not exists sms_events_provider_idx
  on public.sms_events (provider_id, created_at desc);
create index if not exists sms_events_phone_idx
  on public.sms_events (phone_e164, created_at desc);
create index if not exists sms_events_status_idx
  on public.sms_events (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Settings (singleton)
--
-- Same enforced-single-row shape as `email_settings`, and for the same reason:
-- the table is one config object, and a second row would mean two answers to
-- "are sends paused?".
--
-- Not merged into `email_settings` despite the obvious pull. That row is read
-- on every transactional email through a 30-second process cache, and widening
-- it would mean an SMS credential rotation invalidates the cache email
-- delivery depends on. Two objects, two caches, one shared secret helper.
-- ---------------------------------------------------------------------------
create table if not exists public.sms_settings (
  id boolean primary key default true check (id),
  -- 'twilio' today. The column exists so switching providers is a settings
  -- change rather than a deploy (see lib/sms/providers/).
  provider text not null default 'twilio'
    check (provider in ('twilio', 'telnyx')),
  -- The sending number, E.164. batch0 uses a verified TOLL-FREE number, which
  -- is deliverable to the North American Numbering Plan only —
  -- isReachableByTollFree() in lib/phone.ts is what keeps an unreachable number
  -- out of the queue instead of billing for a message that is silently dropped.
  from_number text check (from_number is null or from_number ~ '^\+[1-9][0-9]{7,14}$'),
  account_sid text,
  -- AES-256-GCM ciphertext via lib/email/secret.ts — the same helper the SMTP
  -- password uses. An auth token is a bearer credential that can send messages
  -- and read every message ever sent on the account, so a leaked backup should
  -- not hand it over in plaintext.
  auth_token_encrypted text,
  -- Global kill switch, twin of email_settings.automations_paused. Flip it and
  -- every send parks in the outbox instead of going out.
  sms_paused boolean not null default false,
  -- Admin-facing ceiling per drain. The drain also caps itself at 60 per run
  -- (lib/sms/queue.ts), which is what actually fits in the route's 60 seconds.
  max_sends_per_run integer not null default 300
    check (max_sends_per_run between 1 and 2000),
  -- Quiet hours, in the RECIPIENT's local time, inclusive start / exclusive end.
  -- 9am–8pm is the conservative intersection of the federal 8am–9pm rule in
  -- 47 CFR 64.1200(c)(1) and the stricter state windows (Florida's FTSA and
  -- Oklahoma both narrow it).
  quiet_start_hour integer not null default 9
    check (quiet_start_hour between 0 and 23),
  quiet_end_hour integer not null default 20
    check (quiet_end_hour between 1 and 24),
  -- Appended to the first message a number receives, because CTIA requires the
  -- brand name, an opt-out instruction, and a rates disclosure to appear there.
  help_text text not null default
    'batch0: Reply STOP to opt out, HELP for help. Msg&data rates may apply.',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Seeded with no credentials: the feature is inert until someone enters them.
insert into public.sms_settings (id) values (true)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. RLS + grants — service role only
--
-- Every read and write is a server action, a cron route, or the webhook, and
-- each holds the service-role client after checking its own permission or
-- signature. So the browser roles get nothing: RLS on, no policies, no grants.
--
-- The revokes are NOT optional and NOT redundant with the absent policies.
-- Supabase hands anon and authenticated `grant all on tables` through ALTER
-- DEFAULT PRIVILEGES, and that applies to tables a later migration creates
-- without the migration saying anything — 0084 documents the same trap. RLS
-- would still refuse the read, but a grant that contradicts the intent is a
-- landmine for the next person who adds a permissive policy.
--
-- In particular there is no read policy on `sms_settings`: it holds the
-- encrypted provider credential, and the admin UI reads it through the service
-- role with the secret stripped before it reaches the client bundle — exactly
-- as 0052 treats email_settings.
-- ---------------------------------------------------------------------------
alter table public.messaging_consent enable row level security;
alter table public.messaging_consent_log enable row level security;
alter table public.sms_outbox enable row level security;
alter table public.sms_campaigns enable row level security;
alter table public.sms_events enable row level security;
alter table public.sms_settings enable row level security;

revoke all on public.messaging_consent from anon, authenticated;
revoke all on public.messaging_consent_log from anon, authenticated;
revoke all on public.sms_outbox from anon, authenticated;
revoke all on public.sms_campaigns from anon, authenticated;
revoke all on public.sms_events from anon, authenticated;
revoke all on public.sms_settings from anon, authenticated;

grant all on public.messaging_consent to service_role;
grant all on public.messaging_consent_log to service_role;
grant all on public.sms_outbox to service_role;
grant all on public.sms_campaigns to service_role;
grant all on public.sms_events to service_role;
grant all on public.sms_settings to service_role;
-- No sequence grant for messaging_consent_log.id: GENERATED ALWAYS AS IDENTITY
-- ties the sequence to the column, so INSERT on the table is sufficient.

notify pgrst, 'reload schema';
