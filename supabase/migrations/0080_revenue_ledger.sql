-- Deploy before the payment/accounting code. No estimated historical paid dates:
-- reconcile Stripe success events to populate paid_at where evidence is available.
alter table public.payments
  add column if not exists paid_at timestamptz,
  add column if not exists amount_refunded_cents integer not null default 0 check (amount_refunded_cents >= 0);
alter table public.user_charges
  add column if not exists captured_amount_cents integer,
  add column if not exists captured_currency text,
  add column if not exists amount_refunded_cents integer not null default 0 check (amount_refunded_cents >= 0);
alter table public.demo_day_tickets
  add column if not exists captured_amount_cents integer,
  add column if not exists captured_currency text,
  add column if not exists amount_refunded_cents integer not null default 0 check (amount_refunded_cents >= 0);
update public.payments set amount_refunded_cents = amount_cents where status = 'refunded';
update public.user_charges set amount_refunded_cents = amount_cents where status = 'refunded';
update public.demo_day_tickets set amount_refunded_cents = amount_cents where status = 'refunded';
create index if not exists payments_paid_at_idx on public.payments(paid_at);

-- Shared lock order with checkout reservation: cohort, then application.
-- Recording real money is separate from granting access. Closed admissions
-- never erase money, and a replay never resurrects a refunded checkout.
create or replace function public.settle_enrollment_payment(
  p_session_id text, p_user_id uuid, p_application_id uuid, p_cohort_id uuid,
  p_amount_cents integer, p_currency text, p_payment_intent_id text,
  p_receipt_url text, p_paid_at timestamptz, p_reservation_id uuid default null, p_refunded_cents integer default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.applications%rowtype;
  p public.payments%rowtype;
  was_enrolled boolean;
  blocked boolean;
begin
  if p_amount_cents < 0 or p_currency !~ '^[a-z]{3}$' then raise exception 'Invalid payment amount/currency'; end if;
  if p_cohort_id is not null then perform 1 from public.cohorts where id = p_cohort_id for update; end if;
  select * into a from public.applications where id = p_application_id for update;
  if not found or a.user_id <> p_user_id or a.cohort_id is distinct from p_cohort_id then
    raise exception 'Payment application identity mismatch';
  end if;
  select * into p from public.payments where stripe_session_id = p_session_id order by created_at limit 1 for update;
  if found then
    if p.user_id <> p_user_id or p.application_id is distinct from p_application_id then raise exception 'Payment ledger identity mismatch'; end if;
    update public.payments set
      amount_cents = p_amount_cents, currency = p_currency,
      amount_refunded_cents = greatest(amount_refunded_cents,p_refunded_cents),
      paid_at = coalesce(p_paid_at, paid_at), stripe_payment_intent_id = p_payment_intent_id,
      stripe_receipt_url = coalesce(p_receipt_url, stripe_receipt_url),
      status = case when status = 'refunded' or (p_amount_cents > 0 and greatest(amount_refunded_cents,p_refunded_cents) >= p_amount_cents) then 'refunded' else 'succeeded' end
    where id = p.id returning * into p;
  else
    insert into public.payments(user_id, application_id, cohort_id, stripe_session_id, stripe_payment_intent_id,
      amount_cents, currency, status, stripe_receipt_url, paid_at, amount_refunded_cents)
    values(p_user_id,p_application_id,p_cohort_id,p_session_id,p_payment_intent_id,p_amount_cents,p_currency,case when p_amount_cents > 0 and p_refunded_cents >= p_amount_cents then 'refunded' else 'succeeded' end,p_receipt_url,p_paid_at,p_refunded_cents)
    returning * into p;
  end if;
  select exists(select 1 from public.enrollments where user_id = p_user_id and cohort_id = p_cohort_id) into was_enrolled;
  blocked := p.status = 'refunded' or a.status in ('withdrawn','rejected');
  if not blocked then
    if p_cohort_id is not null then
      insert into public.enrollments(user_id,cohort_id,application_id) values(p_user_id,p_cohort_id,p_application_id)
        on conflict(user_id,cohort_id) do nothing;
    end if;
    update public.applications set status = case when p_cohort_id is null then 'paid' else 'enrolled' end,
      paid_at = coalesce(a.paid_at,p_paid_at), stripe_payment_intent_id = p_payment_intent_id
      where id = p_application_id;
  end if;
  return jsonb_build_object('newly_enrolled',not was_enrolled and not blocked,'blocked',blocked);
end $$;
revoke all on function public.settle_enrollment_payment(text,uuid,uuid,uuid,integer,text,text,text,timestamptz,uuid,integer) from public, anon, authenticated;
grant execute on function public.settle_enrollment_payment(text,uuid,uuid,uuid,integer,text,text,text,timestamptz,uuid,integer) to service_role;

create or replace function public.apply_enrollment_refund(
  p_payment_intent_id text, p_amount_cents integer, p_refunded_cents integer, p_currency text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.payments%rowtype;
  replacement public.payments%rowtype;
  total_refunded integer;
  changed boolean;
begin
  select * into p from public.payments where stripe_payment_intent_id = p_payment_intent_id
    and status in ('succeeded','refunded') order by created_at limit 1;
  if not found then return jsonb_build_object('matched',false); end if;
  if p.cohort_id is not null then perform 1 from public.cohorts where id = p.cohort_id for update; end if;
  if p.application_id is not null then perform 1 from public.applications where id = p.application_id for update; end if;
  select * into p from public.payments where id = p.id for update;
  -- Out-of-order refund events cannot decrease the recorded refund.
  total_refunded := greatest(p.amount_refunded_cents,least(p_amount_cents,p_refunded_cents));
  changed := total_refunded <> p.amount_refunded_cents or p.amount_cents <> p_amount_cents;
  update public.payments set amount_cents = p_amount_cents,currency = p_currency,
    amount_refunded_cents = total_refunded,
    status = case when total_refunded >= p_amount_cents then 'refunded' else 'succeeded' end
    where id = p.id;
  if total_refunded >= p_amount_cents and p.application_id is not null then
    -- A captured payment awaiting staff review is real money, but is not an
    -- alternative entitlement. Only an already fulfilled application can
    -- preserve access when the original payment is fully returned.
    select candidate.* into replacement from public.payments candidate
      join public.applications entitled on entitled.id=candidate.application_id
        and entitled.user_id=candidate.user_id
        and entitled.cohort_id is not distinct from candidate.cohort_id
        and entitled.status in ('paid','enrolled')
      where candidate.id <> p.id and candidate.user_id = p.user_id
      and candidate.cohort_id is not distinct from p.cohort_id and candidate.status = 'succeeded'
      and (candidate.amount_cents = 0 or candidate.amount_cents > candidate.amount_refunded_cents)
      order by candidate.paid_at desc nulls last,candidate.created_at desc limit 1;
    if found then
      -- If the old checkout owned the enrollment, retain access under the
      -- replacement application. Never delete a different enrollment.
      update public.enrollments set application_id = coalesce(replacement.application_id,application_id)
        where application_id = p.application_id;
      if replacement.application_id = p.application_id then
        update public.applications set stripe_payment_intent_id = replacement.stripe_payment_intent_id,
          paid_at = replacement.paid_at where id = p.application_id;
      else
        update public.applications set status = 'withdrawn',paid_at = null
          where id = p.application_id and status in ('accepted','paid','enrolled');
      end if;
    else
      delete from public.enrollments where application_id = p.application_id;
      -- Refunded customers are excluded from automatic payment recovery.
      update public.applications set status = 'withdrawn',paid_at = null
        where id = p.application_id and status in ('accepted','paid','enrolled');
    end if;
  end if;
  return jsonb_build_object('matched',true,'changed',changed,'user_id',p.user_id,'full',total_refunded >= p_amount_cents);
end $$;
revoke all on function public.apply_enrollment_refund(text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.apply_enrollment_refund(text,integer,integer,text) to service_role;
