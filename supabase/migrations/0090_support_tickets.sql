-- ============================================================================
-- 0090 — Support tickets: a request form, a tokenized thread, an admin queue.
--
-- Why this exists
-- ---------------
-- Until now every policy on the site ended the same way: "email
-- hello@batch0.org". That is a fine mailbox and a bad system of record. It
-- cannot tell you how many refund requests are open, it cannot prove when one
-- arrived, and the single most time-sensitive promise batch0 makes — the
-- 48-hour refund window in app/(legal)/refund-policy — was resolved by
-- reading a mail server's Received header.
--
-- A ticket is that promise made legible. `received_at` is the authoritative
-- moment the request reached us — for a request filed through the form, the
-- moment it was saved; for one the team logged on someone's behalf, the moment
-- the email or call actually arrived — `reference` is the thing a person can
-- quote back, and the thread is the audit trail of what we said. The refund
-- policy names this form as a valid channel next to email, so these rows are a
-- formal instrument and not a convenience inbox.
--
-- What a ticket is NOT
-- -------------------
-- Not a discussion (0068). A discussion is an enrolled student asking the team
-- a question about the programme; it is scoped to a cohort, it is pedagogical,
-- and it dies with the cohort. A ticket is administrative — an account, a
-- charge, a statutory data right, a safety concern — it has no cohort, and it
-- deliberately outlives the account it came from (see the `user_id` note).
--
-- Who can read one
-- ----------------
-- Three principals, and no others:
--   * the requester, via `user_id` (they filed it signed in, or the team logged
--     it against their account) or by holding `token`, which is the whole
--     authorization for /support/t/<token> exactly as in lib/demo-day-tickets.ts;
--   * anyone with `support.view` or `support.manage` — reading a ticket means
--     reading someone's email address and often their billing situation, which
--     is why both keys are marked sensitive at /admin/roles. A `sensitive`
--     ticket (a confidential concern: safety, harassment, wellbeing) is the
--     exception: it additionally needs `support.sensitive`, which is meant for
--     a small number of senior staff;
--   * the `*` wildcard admin.
-- The only write policies are the staff `for all` ones below, which need
-- `support.manage` (plus `support.sensitive` on a sensitive ticket). There is
-- deliberately no policy that would let a REQUESTER write: every
-- requester-side write goes through the service role in lib/support.ts, so the
-- anon-key browser client cannot hand-write a ticket claiming to be someone
-- else's email, and cannot forge `is_staff`, `via` or `is_internal` on a reply.
--
-- Outside the three support tables this touches exactly four things, each
-- explained where it happens: one index on payments (section 3), the
-- support-attachments storage bucket (section 7), the rate_limits lockdown
-- (section 8), and the notifications dedupe index (section 9).
--
-- Idempotent / safe to re-run — including over an earlier draft of this file:
-- new columns arrive through `add column if not exists`, every CHECK that
-- changed is dropped and re-added by name, and the one index whose key changed
-- has a new name. Apply with `supabase db push` (or paste into the SQL editor).
-- Assumes 0001..0089 are applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tickets
-- ----------------------------------------------------------------------------

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),

  -- The quotable id, e.g. 'B0-4F2A-9C7K'. Safe to print in an email subject,
  -- a receipt, or a chargeback response, because knowing it grants nothing.
  -- Format and alphabet are pinned in lib/support-access.ts (no I/L/O/U, no
  -- 0/1) so it survives being read aloud or retyped off a screenshot.
  reference text not null unique
    check (reference ~ '^B0-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$'),

  -- The bearer capability for the requester's own thread page. 32 random bytes
  -- base64url, same shape as lib/payer-token.ts. Unlike the payer token this
  -- one is stored in the clear: it is a read capability on a single thread the
  -- holder already authored, it has to survive being clicked out of an email
  -- weeks later, and hashing it would mean the emailed link could never be
  -- regenerated. It still must never reach analytics or a Referer header —
  -- /support/t/[token] is noindex + no-store for that reason.
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{43}$'),

  -- Nullable, and `on delete set null` rather than cascade, on purpose. A
  -- self-filed ticket always starts with an account (only signed-in people can
  -- open one), and a ticket the team logs for someone without an account — a
  -- parent who emailed — starts without one. Either way the ticket must
  -- outlive the profile. The case that forces it: someone files a `privacy`
  -- ticket asking us to delete their account, we honour it, and the record
  -- proving we honoured it must not be destroyed by the very deletion it
  -- requested. `requester_email` below is the snapshot that keeps the row
  -- answerable afterwards.
  user_id uuid references public.profiles(id) on delete set null,

  -- Snapshot, lowercased on write. Not read through the join, because the join
  -- can disappear (above) and because a person may change their account email
  -- mid-thread and still expect replies where they filed from.
  requester_email text not null,
  requester_name text check (requester_name is null or char_length(requester_name) <= 120),

  -- Checked in section 1c, by name, so a widened list lands on a re-run.
  category text not null,

  subject text not null check (char_length(subject) between 1 and 160),
  body text not null check (char_length(body) between 20 and 8000),

  status text not null default 'open'
    check (status in ('open', 'waiting_on_requester', 'resolved', 'closed')),

  -- Stored rather than derived. The queue is `where needs_reply` and nothing
  -- else — the same doctrine as discussion_threads.needs_reply in 0068 — which
  -- makes the one query that matters a partial-index lookup instead of a
  -- correlated subquery over every reply. It is true exactly when the status
  -- is 'open': every status change goes through lib/support-access.ts
  -- statusChangeFields(), which writes the two together.
  needs_reply boolean not null default true,

  -- Triage. The server sets it from the category at filing time (a concern is
  -- urgent, a refund is high, feedback is low); staff can change it. It picks
  -- the reply target in lib/support-access.ts SLA_TARGET_HOURS. Checked in 1c.
  priority text not null default 'normal',

  -- A confidential concern. Set by the server when the category is `concern`;
  -- only holders of support.sensitive (and `*`) can see or handle the ticket,
  -- and every bell and team email about it is stripped of its content. Sticky:
  -- recategorising a concern never clears it — only a support.sensitive holder
  -- can, deliberately, through the admin's sensitive toggle.
  sensitive boolean not null default false,

  -- How the request reached us: 'web' / 'app' for the form (the surface it was
  -- filed from), 'email' / 'phone' / 'other' when staff logged it. Checked in 1c.
  channel text not null default 'web',

  -- Technical and prefill context the server whitelisted at filing time — the
  -- page the person came from (pathname only, never a secret URL), an error
  -- digest, a user agent, which payment they meant. Never client JSON stored
  -- as-is: lib/support-access.ts sanitizeContext() builds it key by key. The
  -- size cap is a backstop for that promise. Checked in 1c.
  context jsonb not null default '{}'::jsonb,

  -- Optional, set when the ticket is resolved or closed: how it ended. Cleared
  -- if the ticket reopens. Checked in 1c.
  outcome text,

  -- Whatever the person pasted from their receipt: a cs_…, a pi_…, a receipt
  -- URL, or a PayPal transaction id. Free text on purpose — the refund policy
  -- asks for "your Stripe or PayPal receipt or transaction ID" and there is no
  -- PayPal anywhere in this schema, so anything typed here may be
  -- unresolvable and still perfectly valid evidence for a human.
  receipt_ref text check (receipt_ref is null or char_length(receipt_ref) <= 200),

  -- The tuition charge this is about: picked by the requester from their own
  -- payments when they filed (the server verifies ownership), or linked by an
  -- admin afterwards, so the ticket links to money rather than describing it.
  -- Fees, fines and Demo Day tickets live in other tables and are recorded in
  -- `context` instead.
  payment_id uuid references public.payments(id) on delete set null,

  assigned_to uuid references public.profiles(id) on delete set null,

  -- The staff member who logged this on someone's behalf. Null when the
  -- requester filed it themselves.
  created_by uuid references public.profiles(id) on delete set null,

  -- PUBLIC messages only. Internal notes are excluded, because the requester
  -- sees this number and "3 replies" over a one-reply thread is a leak.
  reply_count int not null default 0,

  -- THE refund clock. Equal to created_at for a self-filed ticket; for a
  -- logged one it is when the email or call arrived, which may be hours before
  -- the row was written. Checked in 1c: never meaningfully after the row
  -- existed (five minutes of clock skew allowed).
  received_at timestamptz not null default now(),
  -- When the requester last wrote. The reply target ("needs a reply within
  -- 24 hours") runs from here, not from last_activity_at — a staff note saying
  -- "looking into it" must not reset the clock on someone still waiting.
  requester_activity_at timestamptz not null default now(),
  -- The first PUBLIC reply from a person on the team (not a note, not an
  -- automated system message) — time to first response.
  first_response_at timestamptz,
  -- The last PUBLIC message on the thread. The queue and the requester's list
  -- sort on this, so a three-week-old ticket that just got a follow-up rises;
  -- an internal note does not move it.
  last_activity_at timestamptz not null default now(),
  -- When the status last changed. The housekeeping cron reads it: a ticket
  -- waiting on its requester for 7 days is resolved, a resolved one is closed
  -- after 14.
  status_changed_at timestamptz not null default now(),
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.support_tickets is
  'Support requests. received_at is the authoritative arrival time for the 48-hour refund window in app/(legal)/refund-policy; token is the bearer capability for the requester''s thread page; sensitive rows need support.sensitive.';

-- ----------------------------------------------------------------------------
-- 1a. Replies
-- ----------------------------------------------------------------------------

create table if not exists public.support_ticket_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,

  -- Null when the author's profile has since been deleted, when a token holder
  -- posted on a ticket that has no account, and on system messages. Which side
  -- of the conversation a reply came from is answered by is_staff and `via`,
  -- never by whether this is null.
  author_id uuid references public.profiles(id) on delete set null,

  -- Snapshot at post time, derived server-side from the credential used to
  -- post (a support.manage permission check, the owner's session, or
  -- possession of the ticket token). Never taken from the client. Snapshotted
  -- rather than re-derived so the badge doesn't flip on an old reply when
  -- someone's role changes later — the team_messages.kind precedent from 0011.
  is_staff boolean not null default false,

  -- A note the team leaves for itself. Never emailed, never rendered on a
  -- requester's surface — lib/support.ts strips these before the rows reach a
  -- requester-facing component. Requester replies can never set it, and the
  -- CHECK in 1c makes that true at the row level too.
  is_internal boolean not null default false,

  -- Which credential posted it: 'session' (the signed-in owner, on the
  -- dashboard or in the app), 'token' (the emailed thread link), 'staff' (a
  -- support.manage holder), or 'system' (an automated message such as the
  -- auto-resolve note — rendered as from "batch0", with is_staff true and no
  -- author). Checked in 1c, including that staff/system and is_staff agree.
  via text not null default 'session',

  body text not null check (char_length(body) between 1 and 8000),

  -- Claimed before the notification email is sent, so a retried server action
  -- or a double-clicked Send can't mail the same reply twice, and released
  -- again if the send fails so a retry can still deliver it. This column
  -- exists because `dedupeKey` on the direct sendTemplated() path is inert —
  -- only the queued path honours the outbox's unique index — so idempotency
  -- has to live here. See claimReplyNotification in lib/support.ts.
  notified_at timestamptz,

  created_at timestamptz not null default now()
  -- No updated_at. Replies are immutable: delete one, never edit it, so the
  -- thread stays an honest record of what each side actually said.
);

comment on table public.support_ticket_replies is
  'Messages on a support ticket. is_staff and via are server-derived snapshots; is_internal rows are staff-only and never leave the admin surface.';

-- ----------------------------------------------------------------------------
-- 1b. Bringing an earlier draft of this file up to date
--
-- Every statement here is a no-op on tables the `create table` above just
-- made. On a database that ran an earlier draft (none of these columns), it
-- adds them — and backfills the clocks from what the draft did record rather
-- than letting a default stamp every existing ticket with the moment this ran,
-- which would move a refund request's arrival time to "today".
-- ----------------------------------------------------------------------------

alter table public.support_tickets add column if not exists priority text not null default 'normal';
alter table public.support_tickets add column if not exists sensitive boolean not null default false;
alter table public.support_tickets add column if not exists channel text not null default 'web';
alter table public.support_tickets add column if not exists context jsonb not null default '{}'::jsonb;
alter table public.support_tickets add column if not exists outcome text;
alter table public.support_tickets add column if not exists created_by uuid
  references public.profiles(id) on delete set null;
alter table public.support_tickets add column if not exists first_response_at timestamptz;
alter table public.support_tickets add column if not exists received_at timestamptz;
alter table public.support_tickets add column if not exists requester_activity_at timestamptz;
alter table public.support_tickets add column if not exists status_changed_at timestamptz;

-- The draft only had self-filed tickets, so arrival = creation.
update public.support_tickets set received_at = created_at where received_at is null;
update public.support_tickets set status_changed_at = coalesce(resolved_at, created_at)
  where status_changed_at is null;
update public.support_tickets t
  set requester_activity_at = coalesce(
    (select max(r.created_at) from public.support_ticket_replies r
      where r.ticket_id = t.id and not r.is_staff),
    t.created_at)
  where t.requester_activity_at is null;

alter table public.support_tickets
  alter column received_at set default now(),
  alter column received_at set not null,
  alter column requester_activity_at set default now(),
  alter column requester_activity_at set not null,
  alter column status_changed_at set default now(),
  alter column status_changed_at set not null;

-- Every requester reply in the draft came through the emailed token link —
-- there was no other requester path yet.
alter table public.support_ticket_replies add column if not exists via text;
update public.support_ticket_replies
  set via = case when is_staff then 'staff' else 'token' end
  where via is null;
alter table public.support_ticket_replies
  alter column via set default 'session',
  alter column via set not null;

-- The draft's trigger stamped neither of these and counted internal notes.
-- Both statements are guarded so they only ever touch a row that is wrong.
update public.support_tickets t
  set first_response_at = (
    select min(r.created_at) from public.support_ticket_replies r
    where r.ticket_id = t.id and r.via = 'staff' and not r.is_internal)
  where t.first_response_at is null
    and exists (
      select 1 from public.support_ticket_replies r
      where r.ticket_id = t.id and r.via = 'staff' and not r.is_internal);
update public.support_tickets t
  set reply_count = c.n
  from (
    select ticket_id, (count(*) filter (where not is_internal))::int as n
    from public.support_ticket_replies group by ticket_id
  ) c
  where c.ticket_id = t.id and t.reply_count <> c.n;

-- ----------------------------------------------------------------------------
-- 1c. Vocabularies and invariants, by name
--
-- Each list is text + CHECK rather than a Postgres enum, the same as every
-- status column in this schema (applications_status_check, widened by drop
-- and re-add in 0045, is the precedent): an enum value can never be removed,
-- and a value added with ALTER TYPE cannot be used in the transaction that
-- adds it, which is the transaction a migration runs in. Named and dropped
-- before being re-added so a widened list reaches a database that already has
-- the table — `create table if not exists` alone would leave the old CHECK in
-- place. Each list mirrors a constant in lib/support-access.ts, and
-- lib/support-access.test.ts reads the lists back out of this file to prove it.
-- ----------------------------------------------------------------------------

alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('refund', 'billing', 'account', 'technical', 'application', 'program', 'concern', 'accessibility', 'privacy', 'feedback', 'other'));

alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));

alter table public.support_tickets drop constraint if exists support_tickets_channel_check;
alter table public.support_tickets add constraint support_tickets_channel_check
  check (channel in ('web', 'app', 'email', 'phone', 'other'));

alter table public.support_tickets drop constraint if exists support_tickets_outcome_check;
alter table public.support_tickets add constraint support_tickets_outcome_check
  check (outcome is null or outcome in ('answered', 'fixed', 'refunded', 'partially_refunded', 'declined', 'duplicate', 'no_response', 'other'));

alter table public.support_tickets drop constraint if exists support_tickets_context_check;
alter table public.support_tickets add constraint support_tickets_context_check
  check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 4096);

-- A logged request's arrival can be days in the past, never in the future.
alter table public.support_tickets drop constraint if exists support_tickets_received_at_check;
alter table public.support_tickets add constraint support_tickets_received_at_check
  check (received_at <= created_at + interval '5 minutes');

alter table public.support_ticket_replies drop constraint if exists support_ticket_replies_via_check;
alter table public.support_ticket_replies add constraint support_ticket_replies_via_check
  check (via in ('session', 'token', 'staff', 'system'));

-- The two snapshots can't contradict each other: a staff or system message is
-- the team's side, anything else is the requester's.
alter table public.support_ticket_replies drop constraint if exists support_ticket_replies_via_side_check;
alter table public.support_ticket_replies add constraint support_ticket_replies_via_side_check
  check ((via in ('staff', 'system')) = is_staff);

-- Only the team can write a note to itself.
alter table public.support_ticket_replies drop constraint if exists support_ticket_replies_internal_check;
alter table public.support_ticket_replies add constraint support_ticket_replies_internal_check
  check (not is_internal or is_staff);

-- ----------------------------------------------------------------------------
-- 2. Attachments
--
-- A row per file. The bytes live in the private `support-attachments` bucket
-- (section 7); this row is what authorizes reading them, because the bucket
-- has no storage.objects policy at all — the download routes check the
-- ticket, then sign a ten-minute URL with the service role.
-- ----------------------------------------------------------------------------

create table if not exists public.support_ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  -- Null = attached to the original request rather than to a reply.
  reply_id uuid references public.support_ticket_replies(id) on delete cascade,
  uploaded_by uuid references public.profiles(id) on delete set null,
  -- Snapshots, exactly as on replies: which side uploaded it, and whether it
  -- belongs to an internal note (staff-only, like the note itself).
  is_staff boolean not null default false,
  is_internal boolean not null default false,
  -- Server-built, never client-chosen: u/<user_id>/<uuid>-<safe-name> for a
  -- file staged before the ticket existed, t/<ticket_id>/<uuid>-<safe-name>
  -- for everything after.
  storage_path text not null unique check (char_length(storage_path) between 1 and 512),
  file_name text not null check (char_length(file_name) between 1 and 200),
  -- Storage-reported, not client-reported.
  content_type text not null default 'application/octet-stream'
    check (char_length(content_type) <= 200),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  created_at timestamptz not null default now(),
  constraint support_ticket_attachments_internal_check check (not is_internal or is_staff)
);

comment on table public.support_ticket_attachments is
  'Files on a support ticket or reply. Bytes are in the private support-attachments bucket, which has no storage policies; this row is the authorization.';

-- ----------------------------------------------------------------------------
-- 3. Indexes — one per query that actually runs
-- ----------------------------------------------------------------------------

-- The queue: `where needs_reply`, longest-waiting first. Keyed on
-- requester_activity_at because that is where the reply target runs from
-- (lib/support.ts orders the page by the target's due time). An earlier draft
-- of this file had this index on last_activity_at under another name, which
-- `create index if not exists` would have kept forever — hence the drop.
drop index if exists public.support_tickets_queue_idx;
create index if not exists support_tickets_needs_reply_idx
  on public.support_tickets (requester_activity_at) where needs_reply;

-- The other admin views (waiting / resolved / closed), newest activity first.
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_activity_at desc);

-- The requester's own list, on the dashboard and in the app.
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc) where user_id is not null;

-- Every ticket from one person, including after their profile is gone and for
-- people who never had one — the "other requests by this person" panel.
create index if not exists support_tickets_email_idx
  on public.support_tickets (requester_email, created_at desc);

-- "Assigned to me".
create index if not exists support_tickets_assignee_idx
  on public.support_tickets (assigned_to, last_activity_at desc) where assigned_to is not null;

-- The housekeeping cron: waiting for 7 days, resolved for 14.
create index if not exists support_tickets_housekeeping_idx
  on public.support_tickets (status, status_changed_at);

create index if not exists support_ticket_replies_thread_idx
  on public.support_ticket_replies (ticket_id, created_at);

create index if not exists support_ticket_attachments_ticket_idx
  on public.support_ticket_attachments (ticket_id, created_at);
create index if not exists support_ticket_attachments_reply_idx
  on public.support_ticket_attachments (reply_id) where reply_id is not null;

-- `token` and `reference` are already unique-indexed by their constraints, so
-- the lookups that authorize a page need nothing further here.

-- Not used by the ticket code, which finds a refund's charge among the
-- requester's own payments by user_id. It is here because the refund path
-- itself needed it and this migration is the one that made refunds a
-- first-class request: apply_enrollment_refund (0080) matches
-- `stripe_payment_intent_id = p_payment_intent_id` on every charge.refunded
-- webhook and every admin refund, and pi_… had no index at all (cs_… has
-- payments_stripe_session_id_idx from 0050). A plain create, not
-- CONCURRENTLY: db push runs each migration in a transaction, and the
-- tuition ledger is small.
create index if not exists payments_stripe_payment_intent_id_idx
  on public.payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

-- ----------------------------------------------------------------------------
-- 4. Triggers
-- ----------------------------------------------------------------------------

drop trigger if exists touch_support_tickets on public.support_tickets;
create trigger touch_support_tickets before update on public.support_tickets
  for each row execute procedure public.touch_updated_at();

-- Keeps the ticket's counters and clocks true without the application having
-- to remember, with the visibility rules built in:
--   * reply_count counts PUBLIC replies only (the requester sees it);
--   * last_activity_at moves on a public message, never on an internal note;
--   * requester_activity_at moves when the requester writes;
--   * first_response_at is stamped by the first public reply from a person on
--     the team — not a note, and not an automated 'system' message.
-- A delete recounts and leaves the clocks alone.
--
-- It recounts with count(*) rather than incrementing, and it locks the ticket
-- row first. Both matter, as in dm_messages_touch_conversation() (0089): under
-- READ COMMITTED, two replies landing at once would each count under a
-- snapshot taken before the other committed and the second write would keep a
-- stale number; taking the row lock first makes the count below run after any
-- concurrent reply has committed. NO KEY UPDATE rather than UPDATE because
-- every reply insert already holds KEY SHARE on this row through its foreign
-- key, and FOR UPDATE conflicts with that — two concurrent replies would
-- deadlock.
create or replace function public.support_ticket_replies_touch_ticket()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  tid uuid := coalesce(new.ticket_id, old.ticket_id);
begin
  perform 1 from public.support_tickets where id = tid for no key update;

  if tg_op = 'INSERT' then
    update public.support_tickets t
    set reply_count = (
          select count(*) from public.support_ticket_replies r
          where r.ticket_id = tid and not r.is_internal
        ),
        last_activity_at = case
          when new.is_internal then t.last_activity_at else now() end,
        requester_activity_at = case
          when new.is_staff then t.requester_activity_at else now() end,
        first_response_at = case
          when new.is_staff and not new.is_internal and new.via <> 'system'
            then coalesce(t.first_response_at, now())
          else t.first_response_at end
    where t.id = tid;
  else
    update public.support_tickets t
    set reply_count = (
          select count(*) from public.support_ticket_replies r
          where r.ticket_id = tid and not r.is_internal
        )
    where t.id = tid;
  end if;
  return null;
end;
$$;

drop trigger if exists support_ticket_replies_touch_ticket on public.support_ticket_replies;
create trigger support_ticket_replies_touch_ticket
  after insert or delete on public.support_ticket_replies
  for each row execute procedure public.support_ticket_replies_touch_ticket();

-- ----------------------------------------------------------------------------
-- 5. Row level security
--
-- RLS here is the backstop, not the mechanism. Every read and write in
-- lib/support.ts runs on the service role and filters on the viewer, the
-- token, or the staff scope explicitly, because the token path has no
-- auth.uid() to key off at all. These policies exist so that a future direct
-- query — from the anon-key browser client, from a PostgREST call, from the
-- next person who adds a feature here — still cannot read a stranger's ticket,
-- and still cannot read a confidential concern without support.sensitive.
--
-- Keep in lockstep with lib/support-access.ts (supportScopeFor,
-- canStaffSeeTicket) and the filters in lib/support.ts. A divergence is a
-- silent privilege bug, not a build error.
-- ----------------------------------------------------------------------------

alter table public.support_tickets enable row level security;
alter table public.support_ticket_replies enable row level security;
alter table public.support_ticket_attachments enable row level security;

drop policy if exists "support_tickets read" on public.support_tickets;
create policy "support_tickets read" on public.support_tickets
  for select using (
    user_id = auth.uid()
    or public.is_admin(auth.uid())
    or (
      (
        public.has_permission(auth.uid(), 'support.view')
        or public.has_permission(auth.uid(), 'support.manage')
      )
      and (not sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
    )
  );

drop policy if exists "support_tickets staff write" on public.support_tickets;
create policy "support_tickets staff write" on public.support_tickets
  for all using (
    public.is_admin(auth.uid())
    or (
      public.has_permission(auth.uid(), 'support.manage')
      and (not sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
    )
  ) with check (
    public.is_admin(auth.uid())
    or (
      public.has_permission(auth.uid(), 'support.manage')
      and (not sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
    )
  );

-- A reply is exactly as visible as its ticket: the nested select runs under
-- the *reader's* own RLS, so the rule for a reply can never drift from the
-- rule for its thread — the 0084 idiom. An internal note additionally needs
-- the reader to see the ticket AS STAFF, sensitivity included. Checking only
-- "holds support.view" would show a staff member the team's notes on their own
-- confidential concern, which they can read as its requester but not as staff.
drop policy if exists "support_ticket_replies read" on public.support_ticket_replies;
create policy "support_ticket_replies read" on public.support_ticket_replies
  for select using (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_replies.ticket_id
        and (
          not support_ticket_replies.is_internal
          or public.is_admin(auth.uid())
          or (
            (
              public.has_permission(auth.uid(), 'support.view')
              or public.has_permission(auth.uid(), 'support.manage')
            )
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
  );

drop policy if exists "support_ticket_replies staff write" on public.support_ticket_replies;
create policy "support_ticket_replies staff write" on public.support_ticket_replies
  for all using (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_replies.ticket_id
        and (
          public.is_admin(auth.uid())
          or (
            public.has_permission(auth.uid(), 'support.manage')
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
  ) with check (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_replies.ticket_id
        and (
          public.is_admin(auth.uid())
          or (
            public.has_permission(auth.uid(), 'support.manage')
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
  );

-- Attachments follow the same rule as replies, plus one more nested select: a
-- file on a reply is only as visible as that reply, so a file on an internal
-- note stays hidden from the requester even if its own is_internal flag were
-- ever written wrong.
drop policy if exists "support_ticket_attachments read" on public.support_ticket_attachments;
create policy "support_ticket_attachments read" on public.support_ticket_attachments
  for select using (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_attachments.ticket_id
        and (
          not support_ticket_attachments.is_internal
          or public.is_admin(auth.uid())
          or (
            (
              public.has_permission(auth.uid(), 'support.view')
              or public.has_permission(auth.uid(), 'support.manage')
            )
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
    and (
      support_ticket_attachments.reply_id is null
      or exists (
        select 1 from public.support_ticket_replies r
        where r.id = support_ticket_attachments.reply_id
      )
    )
  );

drop policy if exists "support_ticket_attachments staff write" on public.support_ticket_attachments;
create policy "support_ticket_attachments staff write" on public.support_ticket_attachments
  for all using (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_attachments.ticket_id
        and (
          public.is_admin(auth.uid())
          or (
            public.has_permission(auth.uid(), 'support.manage')
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
  ) with check (
    exists (
      select 1 from public.support_tickets t
      where t.id = support_ticket_attachments.ticket_id
        and (
          public.is_admin(auth.uid())
          or (
            public.has_permission(auth.uid(), 'support.manage')
            and (not t.sensitive or public.has_permission(auth.uid(), 'support.sensitive'))
          )
        )
    )
  );

-- No requester-side write policy, by design. Creating a ticket, posting a
-- follow-up and attaching a file all go through the service role in
-- lib/support.ts and lib/support-attachments.ts, which is what lets the server
-- own `requester_email`, `is_staff`, `via`, `is_internal`, `token`,
-- `reference`, `sensitive` and `storage_path`. A write policy reachable by the
-- requester would mean the browser could choose them. (The staff `for all`
-- policies above do cover writes, but only for a holder of support.manage.)

-- ----------------------------------------------------------------------------
-- 6. Grants
--
-- The revokes are not optional. Supabase hands anon and authenticated
-- `grant all on tables` through ALTER DEFAULT PRIVILEGES, and that applies to
-- tables a later migration creates without the migration saying anything —
-- 0084 documents the same trap. RLS would still refuse the read, but a
-- grant that contradicts the intent is a landmine for the next person who adds
-- a permissive policy.
-- ----------------------------------------------------------------------------

revoke all on public.support_tickets from anon, authenticated;
revoke all on public.support_ticket_replies from anon, authenticated;
revoke all on public.support_ticket_attachments from anon, authenticated;
grant all on public.support_tickets to service_role;
grant all on public.support_ticket_replies to service_role;
grant all on public.support_ticket_attachments to service_role;

-- ----------------------------------------------------------------------------
-- 7. Storage: the private support-attachments bucket
--
-- Screenshots, receipts and documents someone attaches to a request. Private,
-- 10 MB per file, and — the call-recordings precedent (lib/call-recordings.ts)
-- — deliberately NO storage.objects policy at all. Writes are signed upload
-- URLs the server mints for a path it built; reads are ten-minute signed URLs
-- minted after the download route has checked the ticket. A policy would only
-- be a second, weaker statement of a rule that lives in the attachments table.
--
-- No MIME allow-list, as in 0087: browsers disagree on the type they send for
-- the same file, a bucket-level refusal surfaces as an opaque 400, and the
-- extension and the storage-reported type are checked in code instead
-- (lib/support-attachment-rules.ts), where the error can say something useful.
-- `greatest` means a re-run restores the limit the code assumes but never
-- lowers one someone deliberately raised (the 0084 convention).
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 10485760, null)
on conflict (id) do update
  set public = false,
      allowed_mime_types = null,
      file_size_limit = greatest(
        coalesce(storage.buckets.file_size_limit, 0),
        10485760
      );

-- ----------------------------------------------------------------------------
-- 8. Closing a pre-existing hole in public.rate_limits
--
-- Not strictly part of this feature, and here anyway because this feature
-- writes to that table.
--
-- public.rate_limits (migration 0005) has no RLS, no policies, and no revoke —
-- it predates the discipline the rest of these migrations follow. Its primary
-- key is the rate-limit key in plaintext, and the keys written to it are not
-- opaque: the password-reset flow keys on the user's email address
-- ("password-reset:email:someone@example.com"), so with Supabase's default
-- ALTER DEFAULT PRIVILEGES grant an authenticated browser client can read the
-- table and enumerate the email address of everyone who recently asked for a
-- reset. The support form adds more rows to the same table.
--
-- The token half of the problem is fixed in app/support/actions.ts, which
-- hashes a ticket token before it is ever used as a key. This is the other
-- half: nothing but the service role needs to see this table at all.
-- checkRateLimit (lib/rate-limit.ts) reaches it through createAdminClient, and
-- rate_limit_check is SECURITY DEFINER, so neither is affected by the revoke.
--
-- Never add `force row level security` here. The limiter function runs as the
-- table's owner, which RLS skips unless forced; forcing it would make every
-- limiter call fail, and checkRateLimit fails OPEN — every rate limit in the
-- app would silently switch off.
-- ----------------------------------------------------------------------------

-- Guarded, because this is the one statement in the file that touches a table
-- this migration does not create. `revoke` has no IF EXISTS form, so the
-- existence check has to wrap the whole block rather than decorate it.
do $$
begin
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'rate_limits'
  ) then
    execute 'alter table public.rate_limits enable row level security';
    execute 'revoke all on public.rate_limits from anon, authenticated';
    execute 'grant all on public.rate_limits to service_role';
  end if;
end $$;

-- No policy, deliberately: with RLS on and no policy, every non-service role
-- sees zero rows even if a future migration grants the table back by accident.

-- The same table is also reachable through its function. Postgres grants
-- EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
-- authenticated as well, so anyone holding the public anon key could call
-- POST /rest/v1/rpc/rate_limit_check — burning someone else's limit (three
-- calls with "password-reset:email:<victim>" lock that person out of password
-- reset for fifteen minutes), reading the returned count as an oracle for
-- "did this address just ask for a reset", and inserting arbitrary keys. The
-- only caller is lib/rate-limit.ts on the service role, so EXECUTE goes to
-- that role alone — the 0080/0081/0089 pattern. Guarded the same way.
do $$
begin
  if to_regprocedure('public.rate_limit_check(text,integer)') is not null then
    execute 'revoke execute on function public.rate_limit_check(text, integer) from public, anon, authenticated';
    execute 'grant execute on function public.rate_limit_check(text, integer) to service_role';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 9. The notifications dedupe index (platform-wide fix)
--
-- 0012 made the (user_id, dedupe_key) unique index PARTIAL —
-- `where dedupe_key is not null`. lib/notifications.ts upserts with
-- `onConflict: "user_id,dedupe_key"`, which PostgREST sends as a bare
-- `on conflict (user_id, dedupe_key)`, and Postgres cannot infer a partial
-- index from a bare column list: every deduped notification failed with 42P10
-- ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"), and nothing checked the error, so every bell that passed a
-- dedupe key — this feature's included — silently never arrived.
--
-- A plain unique index on the same columns has the same meaning, because
-- NULLs are distinct in a unique index: rows without a dedupe key still never
-- collide, so building it cannot fail on existing data. Built first, then the
-- partial one is dropped, so there is no moment without the guarantee.
-- Guarded like section 8, since this table is not this migration's.
-- ----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications'
      and column_name = 'dedupe_key'
  ) then
    execute 'create unique index if not exists notifications_user_dedupe_key_idx on public.notifications (user_id, dedupe_key)';
    execute 'drop index if exists public.notifications_user_dedupe_uniq';
  end if;
end $$;

-- Without this the new tables are invisible to PostgREST, which presents as
-- PGRST205 "table not found" from an otherwise correct deploy.
notify pgrst, 'reload schema';
