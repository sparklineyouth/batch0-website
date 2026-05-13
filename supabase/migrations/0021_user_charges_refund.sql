-- Extend user_charges.status to include 'refunded' + track refund
-- metadata so the admin refund flow can mirror the payments table.
alter table public.user_charges
  drop constraint if exists user_charges_status_check;
alter table public.user_charges
  add constraint user_charges_status_check
    check (status in ('pending', 'paid', 'waived', 'cancelled', 'refunded'));

alter table public.user_charges
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references public.profiles(id) on delete set null,
  add column if not exists refund_reason text,
  add column if not exists stripe_refund_id text;
