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
-- A ticket is that promise made legible. `created_at` is the authoritative
-- moment the request reached us, `reference` is the thing a person can quote
-- back, and the thread is the audit trail of what we said. The refund policy
-- is being rewritten in the same change to name this form as a valid channel,
-- so these rows are a formal instrument and not a convenience inbox.
--
-- What a ticket is NOT
-- -------------------
-- Not a discussion (0068). A discussion is an enrolled student asking the team
-- a question about the programme; it is scoped to a cohort, it is pedagogical,
-- and it dies with the cohort. A ticket is administrative — an account, a
-- charge, a statutory data right — it has no cohort, and it deliberately
-- outlives the account it came from (see the `user_id` note below).
--
-- Who can read one
-- ----------------
-- Three principals, and no others:
--   * the requester, via `user_id` (they were signed in when they filed) or by
--     holding `token`, which is the whole authorization for /support/t/<token>
--     exactly as in lib/demo-day-tickets.ts;
--   * anyone with `support.view` — reading a ticket means reading someone's
--     email address and often their billing situation, which is why the key is
--     marked sensitive at /admin/roles;
--   * the `*` wildcard admin.
-- The only write policies are the two `for all` staff ones below, which need
-- `support.manage`. There is deliberately no policy that would let a REQUESTER
-- write: every requester-side write goes through the service role in
-- lib/support.ts, so the anon-key browser client cannot hand-write a ticket
-- claiming to be someone else's email, and cannot forge `is_staff` or
-- `is_internal` on a reply.
--
-- Everything here is additive. No existing table changes meaning; the only
-- edit outside the two new tables is one index on payments, added so a refund
-- ticket can resolve a pasted `pi_…` without a sequential scan.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
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

  -- Nullable, and `on delete set null` rather than cascade, on purpose.
  -- Tickets are only openable by a signed-in account, so this starts non-null
  -- in practice — but a ticket must outlive the profile. The case that forces
  -- it: someone files a `privacy` ticket asking us to delete their account, we
  -- honour it, and the record proving we honoured it must not be destroyed by
  -- the very deletion it requested. `requester_email` below is the snapshot
  -- that keeps the row answerable afterwards.
  user_id uuid references public.profiles(id) on delete set null,

  -- Snapshot, lowercased on write. Not read through the join, because the join
  -- can disappear (above) and because a person may change their account email
  -- mid-thread and still expect replies where they filed from.
  requester_email text not null,
  requester_name text check (requester_name is null or char_length(requester_name) <= 120),

  category text not null check (category in
    ('refund', 'billing', 'account', 'privacy', 'application', 'other')),

  subject text not null check (char_length(subject) between 1 and 160),
  body text not null check (char_length(body) between 20 and 8000),

  status text not null default 'open'
    check (status in ('open', 'waiting_on_requester', 'resolved', 'closed')),

  -- Stored rather than derived. The queue is `where needs_reply` and nothing
  -- else — the same doctrine as discussion_threads.needs_reply in 0068 — which
  -- makes the one query that matters a partial-index lookup instead of a
  -- correlated subquery over every reply. The team's reply clears it, the
  -- requester's follow-up raises it again.
  needs_reply boolean not null default true,

  -- Whatever the person pasted from their receipt: a cs_…, a pi_…, a receipt
  -- URL, or a PayPal transaction id. Free text on purpose — the refund policy
  -- asks for "your Stripe or PayPal receipt or transaction ID" and there is no
  -- PayPal anywhere in this schema, so anything typed here may be
  -- unresolvable and still perfectly valid evidence for a human.
  receipt_ref text check (receipt_ref is null or char_length(receipt_ref) <= 200),

  -- Set when an admin resolves receipt_ref (or the requester's account) to a
  -- real charge, so the ticket links to money rather than describing it.
  payment_id uuid references public.payments(id) on delete set null,

  assigned_to uuid references public.profiles(id) on delete set null,

  reply_count int not null default 0,
  -- Bumped by the trigger below on every reply. The queue sorts on this, not
  -- on created_at, so a three-week-old ticket that just got a follow-up rises.
  last_activity_at timestamptz not null default now(),
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.support_tickets is
  'Support requests. created_at is the authoritative arrival time for the 48-hour refund window in app/(legal)/refund-policy; token is the bearer capability for the requester''s thread page.';

-- ----------------------------------------------------------------------------
-- 2. Replies
-- ----------------------------------------------------------------------------

create table if not exists public.support_ticket_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,

  -- Null when the author's profile has since been deleted. Which side of the
  -- conversation a reply came from is answered by is_staff, never by whether
  -- this is null.
  author_id uuid references public.profiles(id) on delete set null,

  -- Snapshot at post time, derived server-side from the credential used to
  -- post (a support.manage permission check, or possession of the ticket
  -- token). Never taken from the client. Snapshotted rather than re-derived so
  -- the badge doesn't flip on an old reply when someone's role changes later —
  -- the team_messages.kind precedent from 0011.
  is_staff boolean not null default false,

  -- A note the team leaves for itself. Never emailed, never rendered on the
  -- requester's thread page — lib/support.ts strips these before the rows
  -- reach a requester-facing component, and `forRequester` is typed so it
  -- can't be forgotten. Requester replies can never set it (the reply path
  -- for a token holder hard-codes false).
  is_internal boolean not null default false,

  body text not null check (char_length(body) between 1 and 8000),

  -- Claimed before the notification email is sent, so a retried server action
  -- or a double-clicked Send can't mail the same reply twice. This column
  -- exists because `dedupeKey` on the direct sendTemplated() path is inert —
  -- only the queued path honours the outbox's unique index — so idempotency
  -- has to live here. See appendReply in lib/support.ts.
  notified_at timestamptz,

  created_at timestamptz not null default now()
  -- No updated_at. Replies are immutable: delete one, never edit it, so the
  -- thread stays an honest record of what each side actually said.
);

comment on table public.support_ticket_replies is
  'Messages on a support ticket. is_staff is a server-derived snapshot; is_internal rows are staff-only and never leave the admin surface.';

-- ----------------------------------------------------------------------------
-- 3. Indexes — one per query that actually runs
-- ----------------------------------------------------------------------------

-- The queue: `where needs_reply order by last_activity_at`. Partial, because
-- an answered ticket is never in this view and shouldn't be in its index.
create index if not exists support_tickets_queue_idx
  on public.support_tickets (last_activity_at desc) where needs_reply;

-- The non-default admin views (status chips) and the resolved backlog.
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_activity_at desc);

-- "My requests" at /dashboard/support.
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc) where user_id is not null;

-- Finding every ticket from one person, including after their profile is gone.
create index if not exists support_tickets_email_idx
  on public.support_tickets (requester_email, created_at desc);

create index if not exists support_ticket_replies_thread_idx
  on public.support_ticket_replies (ticket_id, created_at);

-- `token` and `reference` are already unique-indexed by their constraints, so
-- the two lookups that authorize a page need nothing further here.

-- A refund ticket resolves the identifier the requester pasted. cs_… already
-- has payments_stripe_session_id_idx (0050); pi_… had no index at all, and it
-- is the likelier paste of the two because it is what appears on a Stripe
-- receipt. Without this, resolving one ticket sequentially scans the tuition
-- ledger.
create index if not exists payments_stripe_payment_intent_id_idx
  on public.payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

-- ----------------------------------------------------------------------------
-- 4. Triggers
-- ----------------------------------------------------------------------------

drop trigger if exists touch_support_tickets on public.support_tickets;
create trigger touch_support_tickets before update on public.support_tickets
  for each row execute procedure public.touch_updated_at();

-- Keeps reply_count and last_activity_at true without the application having
-- to remember. Recounts with count(*) rather than incrementing: two replies
-- landing at once cannot lose an increment to a read-then-write race. A delete
-- recounts too, but does not roll last_activity_at back — the thread did just
-- change, and the queue should reflect that someone touched it.
create or replace function public.support_ticket_replies_touch_ticket()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  tid uuid := coalesce(new.ticket_id, old.ticket_id);
begin
  update public.support_tickets t
  set reply_count = (
        select count(*) from public.support_ticket_replies r where r.ticket_id = tid
      ),
      last_activity_at = now()
  where t.id = tid;
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
-- lib/support.ts runs on the service role and filters on the viewer or the
-- token explicitly, because the token path has no auth.uid() to key off at
-- all. These policies exist so that a future direct query — from the
-- anon-key browser client, from a PostgREST call, from the next person who
-- adds a feature here — still cannot read a stranger's ticket.
--
-- Keep in lockstep with lib/support-access.ts and the filters in
-- lib/support.ts. A divergence is a silent privilege bug, not a build error.
-- ----------------------------------------------------------------------------

alter table public.support_tickets enable row level security;
alter table public.support_ticket_replies enable row level security;

drop policy if exists "support_tickets read" on public.support_tickets;
create policy "support_tickets read" on public.support_tickets
  for select using (
    user_id = auth.uid()
    or public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'support.view')
    or public.has_permission(auth.uid(), 'support.manage')
  );

drop policy if exists "support_tickets staff write" on public.support_tickets;
create policy "support_tickets staff write" on public.support_tickets
  for all using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'support.manage')
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'support.manage')
  );

-- A reply is exactly as visible as its ticket, and internal notes are visible
-- only to the team. The nested select runs under the *reader's* own RLS, so
-- the rule for a reply can never drift from the rule for its thread — the
-- 0084 idiom. The is_internal clause is additive on top of that: a requester
-- who can see the ticket still cannot see the team's notes on it.
drop policy if exists "support_ticket_replies read" on public.support_ticket_replies;
create policy "support_ticket_replies read" on public.support_ticket_replies
  for select using (
    exists (select 1 from public.support_tickets t where t.id = ticket_id)
    and (
      not is_internal
      or public.is_admin(auth.uid())
      or public.has_permission(auth.uid(), 'support.view')
      or public.has_permission(auth.uid(), 'support.manage')
    )
  );

drop policy if exists "support_ticket_replies staff write" on public.support_ticket_replies;
create policy "support_ticket_replies staff write" on public.support_ticket_replies
  for all using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'support.manage')
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'support.manage')
  );

-- No requester-side INSERT policy, by design. Creating a ticket and posting a
-- follow-up both go through the service role in lib/support.ts, which is what
-- lets the server own `requester_email`, `is_staff`, `is_internal`, `token`
-- and `reference`. An insert policy reachable by the requester would mean the
-- browser could choose them. (The staff `for all` policies above do cover
-- insert and update, but only for a holder of support.manage.)

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
grant all on public.support_tickets to service_role;
grant all on public.support_ticket_replies to service_role;

-- ----------------------------------------------------------------------------
-- 7. Closing a pre-existing hole in public.rate_limits
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

-- Without this the new tables are invisible to PostgREST, which presents as
-- PGRST205 "table not found" from an otherwise correct deploy.
notify pgrst, 'reload schema';
