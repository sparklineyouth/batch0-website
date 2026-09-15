-- ============================================================================
-- 0070 — Demo Day tickets: a paid link for Demo Day only, not the cohort.
--
-- An admin sends someone a payment link for Demo Day at whatever price they
-- choose. It is deliberately NOT a `user_charges` row (fees/fines, 0006) and
-- NOT an enrollment: the person may never have signed up for batch0 at all.
-- The row is keyed by EMAIL and a secret `token`, and the pay page
-- (/demo-day/ticket/<token>) needs no account — that is what makes this a
-- "send it to anyone" link rather than a bill on an existing user.
--
-- Lifecycle:
--   sent       the email went out; the link is live and payable.
--   paid       Stripe captured the money (webhook or return-from-Checkout,
--              both through lib/stripe-fulfillment). The ticket is good.
--   cancelled  an admin pulled the link before it was paid. Dead link.
--   refunded   the money went back (admin action or the Stripe dashboard).
--
-- `user_id` is a best-effort link to a batch0 account with the same email —
-- resolved when the ticket is sent and again when it's paid, so someone who
-- signs up in between still gets matched. It's what lets a ticket holder who
-- IS signed in see the Demo Day event on their dashboard (policy below). The
-- ticket itself never depends on it.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0069 are applied.
-- ============================================================================

create table if not exists public.demo_day_tickets (
  id uuid primary key default gen_random_uuid(),
  -- The secret in the pay link. Random, unguessable, and the ONLY thing the
  -- public page and checkout route accept — no ids in URLs.
  token text not null unique,
  -- Recipient. Lowercased on write so the account match below is exact.
  email text not null,
  name text,
  user_id uuid references public.profiles(id) on delete set null,
  -- Which Demo Day. Nullable so a ticket outlives a deleted cohort, and so a
  -- ticket with no cohort reads as "any Demo Day" in the events policy.
  cohort_id uuid references public.cohorts(id) on delete set null,
  -- Whatever the admin typed. Stripe's USD floor is 50 cents; the server
  -- action enforces it, this just refuses nonsense.
  amount_cents integer not null check (amount_cents > 0),
  -- Optional personal line the admin adds to the invite email.
  note text,
  status text not null default 'sent'
    check (status in ('sent','paid','cancelled','refunded')),
  stripe_session_id text,
  stripe_payment_intent_id text,
  stripe_receipt_url text,
  stripe_refund_id text,
  refund_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  cancelled_by uuid references public.profiles(id) on delete set null,
  refunded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Last time the invite email went out (initial send or a resend).
  sent_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz
);

create index if not exists demo_day_tickets_email_idx
  on public.demo_day_tickets (email);
create index if not exists demo_day_tickets_status_idx
  on public.demo_day_tickets (status, created_at desc);
-- The events policy and the ticket holder's own billing page look up by user.
create index if not exists demo_day_tickets_user_idx
  on public.demo_day_tickets (user_id)
  where user_id is not null;
-- Fulfillment and the refund mirror match Stripe objects back to the row.
create index if not exists demo_day_tickets_session_idx
  on public.demo_day_tickets (stripe_session_id)
  where stripe_session_id is not null;
create index if not exists demo_day_tickets_pi_idx
  on public.demo_day_tickets (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

drop trigger if exists touch_demo_day_tickets on public.demo_day_tickets;
create trigger touch_demo_day_tickets before update on public.demo_day_tickets
  for each row execute procedure public.touch_updated_at();

alter table public.demo_day_tickets enable row level security;

-- ----------------------------------------------------------------------------
-- RLS
--
-- Whoever runs Demo Day (demoday.manage) sees and writes every ticket; admins
-- hold the wildcard. A signed-in ticket holder can read their own row (the
-- billing page). The public pay page and the checkout route look rows up by
-- token through the service-role client, never through these policies, so an
-- anonymous visitor can't enumerate anything.
-- ----------------------------------------------------------------------------

drop policy if exists "demo_day_tickets read" on public.demo_day_tickets;
create policy "demo_day_tickets read" on public.demo_day_tickets
  for select using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'demoday.manage')
    or user_id = auth.uid()
  );

drop policy if exists "demo_day_tickets staff write" on public.demo_day_tickets;
create policy "demo_day_tickets staff write" on public.demo_day_tickets
  for all using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'demoday.manage')
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'demoday.manage')
  );

comment on table public.demo_day_tickets is
  'Paid Demo-Day-only tickets sent by an admin to an email address at a custom price. Paid via a tokenised public link; no cohort enrollment. See lib/demo-day-tickets.ts.';

-- ----------------------------------------------------------------------------
-- Let a paid ticket holder see the Demo Day event.
--
-- Same policy as 0005 plus one clause: a signed-in user with a PAID ticket may
-- read `demo_day`-type events for the ticket's cohort (or any cohort, when the
-- ticket wasn't pinned to one). Nothing else opens up — office hours,
-- workshops and everything else stay enrolled-only. This is what makes
-- /dashboard/events and the hosted live page work for a ticket holder, since
-- both read events through RLS.
-- ----------------------------------------------------------------------------

drop policy if exists "events read" on public.events;
create policy "events read" on public.events
  for select using (
    visibility = 'public'
    or public.is_staff(auth.uid())
    or (
      visibility = 'enrolled'
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid() and e.cohort_id = events.cohort_id
      )
    )
    or (
      events.type = 'demo_day'
      and visibility = 'enrolled'
      and exists (
        select 1 from public.demo_day_tickets t
        where t.user_id = auth.uid()
          and t.status = 'paid'
          and (t.cohort_id is null or t.cohort_id = events.cohort_id)
      )
    )
  );

notify pgrst, 'reload schema';
