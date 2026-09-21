-- Parent checkout: capability tokens are hashed; invitations expose no answers.
-- Deploy after 0080 and before the corresponding application release.
alter table public.cohorts add column if not exists late_entry_until timestamptz,
  add column if not exists catch_up_plan text;
alter table public.applications add column if not exists pricing_country text;

create table if not exists public.payer_links (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  quote jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.checkout_reservations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  cohort_id uuid not null references public.cohorts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  quote jsonb not null,
  expires_at timestamptz not null,
  status text not null default 'active' check(status in ('active','completed','released')),
  stripe_session_id text unique,
  created_at timestamptz not null default now()
);
create unique index if not exists checkout_one_active_per_application
  on public.checkout_reservations(application_id) where status = 'active';
create index if not exists checkout_capacity_idx on public.checkout_reservations(cohort_id,expires_at) where status = 'active';
alter table public.payer_links enable row level security;
alter table public.checkout_reservations enable row level security;
revoke all on public.payer_links, public.checkout_reservations from anon,authenticated;
grant all on public.payer_links, public.checkout_reservations to service_role;

-- Same rule as lib/cohort-eligibility.ts, including New York calendar days.
create or replace function public.assert_cohort_admissions(p_cohort_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare c public.cohorts%rowtype; today date := (now() at time zone 'America/New_York')::date;
begin
  select * into c from public.cohorts where id=p_cohort_id;
  if not found or c.status not in ('active','upcoming') or (c.ends_on is not null and today > c.ends_on) then
    raise exception 'This cohort is closed.';
  end if;
  if c.starts_on is not null and today >= c.starts_on then
    if c.late_entry_until is null or now()>c.late_entry_until or coalesce(trim(c.catch_up_plan),'')='' then
      raise exception 'Enrollment has closed. Please choose an upcoming cohort.';
    end if;
  elsif c.applications_close_at is not null and now()>c.applications_close_at then
    raise exception 'The enrollment deadline has passed. Please choose an upcoming cohort.';
  end if;
end $$;
revoke all on function public.assert_cohort_admissions(uuid) from public,anon,authenticated;
grant execute on function public.assert_cohort_admissions(uuid) to service_role;

create or replace function public.reserve_checkout_seat(p_application_id uuid,p_user_id uuid,p_quote jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.applications%rowtype; c public.cohorts%rowtype; r public.checkout_reservations%rowtype; occupied integer;
begin
  select * into a from public.applications where id=p_application_id;
  if not found or a.user_id<>p_user_id or a.cohort_id is null then raise exception 'Application not found.'; end if;
  select * into c from public.cohorts where id=a.cohort_id for update;
  select * into a from public.applications where id=p_application_id for update;
  if not found or a.user_id<>p_user_id or a.cohort_id is distinct from c.id then raise exception 'Application changed. Refresh and try again.'; end if;
  if a.status<>'accepted' then raise exception 'This application is not ready for payment.'; end if;
  if exists(select 1 from public.enrollments where user_id=p_user_id and cohort_id=c.id) then raise exception 'This student is already enrolled.'; end if;
  perform public.assert_cohort_admissions(c.id);
  select * into r from public.checkout_reservations where application_id=a.id and status='active' for update;
  if found and r.expires_at>now() then return to_jsonb(r); end if;
  update public.checkout_reservations set status='released' where application_id=a.id and status='active';
  select (select count(*) from public.enrollments where cohort_id=c.id) +
    (select count(*) from public.checkout_reservations x where x.cohort_id=c.id and x.status='active' and x.expires_at>now()
      and not exists(select 1 from public.enrollments e where e.cohort_id=x.cohort_id and e.user_id=x.user_id)) into occupied;
  if occupied>=c.capacity then raise exception 'This cohort is full. Please choose an upcoming cohort.'; end if;
  if (p_quote->>'amountCents')::integer < 0 or p_quote->>'currency'<>'usd' then raise exception 'Invalid quote.'; end if;
  insert into public.checkout_reservations(application_id,cohort_id,user_id,quote,expires_at)
    values(a.id,c.id,p_user_id,p_quote,now()+interval '35 minutes') returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.reserve_checkout_seat(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_checkout_seat(uuid,uuid,jsonb) to service_role;

-- A service-role checkout session is not returned to a payer until its ledger
-- and reservation are linked atomically. Never store a bearer Stripe URL.
create or replace function public.attach_checkout_session(p_reservation_id uuid,p_session_id text)
returns void language plpgsql security definer set search_path=public as $$
declare r public.checkout_reservations%rowtype;
begin
  select * into r from public.checkout_reservations where id=p_reservation_id;
  if not found then raise exception 'Reservation is unavailable.'; end if;
  perform 1 from public.cohorts where id=r.cohort_id for update;
  perform 1 from public.applications where id=r.application_id for update;
  select * into r from public.checkout_reservations where id=p_reservation_id for update;
  if not found or r.status<>'active' then raise exception 'Reservation is unavailable.'; end if;
  if r.stripe_session_id is not null and r.stripe_session_id<>p_session_id then raise exception 'Reservation session mismatch.'; end if;
  update public.checkout_reservations set stripe_session_id=p_session_id where id=r.id;
  update public.applications set stripe_session_id=p_session_id where id=r.application_id;
  insert into public.payments(user_id,application_id,cohort_id,stripe_session_id,amount_cents,currency,status)
    select r.user_id,r.application_id,r.cohort_id,p_session_id,(r.quote->>'amountCents')::integer,'usd','pending'
    where not exists(select 1 from public.payments where stripe_session_id=p_session_id);
end $$;
revoke all on function public.attach_checkout_session(uuid,text) from public,anon,authenticated;
grant execute on function public.attach_checkout_session(uuid,text) to service_role;

-- Backstops for direct authenticated application writes and manual enrollment.
create or replace function public.check_application_admissions()
returns trigger language plpgsql security definer set search_path=public as $$
declare cap integer; occupied integer;
begin
  -- Only trusted server writes can set pricing geography. An authenticated
  -- browser must not overwrite it through the general application table API.
  if current_setting('role',true) in ('anon','authenticated') then
    if new.status not in ('draft','submitted') or (tg_op='UPDATE' and old.status<>'draft') then
      raise exception 'Admission and payment status can only be changed by staff.';
    end if;
    if tg_op='INSERT' then
      new.pricing_country:=null;
      new.reviewed_by:=null; new.reviewed_at:=null; new.review_notes:=null;
      new.paid_at:=null; new.stripe_session_id:=null; new.stripe_payment_intent_id:=null;
    else
      new.pricing_country:=old.pricing_country;
      new.reviewed_by:=old.reviewed_by; new.reviewed_at:=old.reviewed_at; new.review_notes:=old.review_notes;
      new.paid_at:=old.paid_at; new.stripe_session_id:=old.stripe_session_id;
      new.stripe_payment_intent_id:=old.stripe_payment_intent_id;
    end if;
  end if;
  if tg_op='UPDATE' and (new.cohort_id is distinct from old.cohort_id or new.user_id is distinct from old.user_id)
    and exists(select 1 from public.checkout_reservations where application_id=old.id and status='active' and expires_at>now()) then
    raise exception 'This application has an active checkout. Wait for it to expire before transferring it.';
  end if;
  if new.status='submitted' and (tg_op='INSERT' or old.status is distinct from new.status or old.cohort_id is distinct from new.cohort_id) then
    select capacity into cap from public.cohorts where id=new.cohort_id;
    perform public.assert_cohort_admissions(new.cohort_id);
    select (select count(*) from public.enrollments where cohort_id=new.cohort_id) +
      (select count(*) from public.checkout_reservations x where x.cohort_id=new.cohort_id and x.status='active' and x.expires_at>now()
        and not exists(select 1 from public.enrollments e where e.cohort_id=x.cohort_id and e.user_id=x.user_id)) into occupied;
    if occupied>=cap then raise exception 'This cohort is full. Please choose an upcoming cohort.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists application_admissions_guard on public.applications;
create trigger application_admissions_guard before insert or update on public.applications
  for each row execute function public.check_application_admissions();

create or replace function public.check_enrollment_capacity()
returns trigger language plpgsql security definer set search_path=public as $$
declare cap integer; occupied integer;
begin
  select capacity into cap from public.cohorts where id=new.cohort_id for update;
  if exists(select 1 from public.enrollments where cohort_id=new.cohort_id and user_id=new.user_id) then return new; end if;
  select (select count(*) from public.enrollments where cohort_id=new.cohort_id) +
    (select count(*) from public.checkout_reservations x where x.cohort_id=new.cohort_id and x.user_id<>new.user_id and x.status='active' and x.expires_at>now()
      and not exists(select 1 from public.enrollments e where e.cohort_id=x.cohort_id and e.user_id=x.user_id)) into occupied;
  if occupied>=cap then raise exception 'This cohort is full.'; end if;
  return new;
end $$;
drop trigger if exists enrollment_capacity_guard on public.enrollments;
create trigger enrollment_capacity_guard before insert or update of cohort_id,user_id on public.enrollments
  for each row execute function public.check_enrollment_capacity();

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
  r public.checkout_reservations%rowtype;
  cap integer;
  occupied integer;
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
    values(p_user_id,p_application_id,p_cohort_id,p_session_id,p_payment_intent_id,p_amount_cents,p_currency,case when p_amount_cents>0 and p_refunded_cents>=p_amount_cents then 'refunded' else 'succeeded' end,p_receipt_url,p_paid_at,p_refunded_cents)
    returning * into p;
  end if;
  select exists(select 1 from public.enrollments where user_id = p_user_id and cohort_id = p_cohort_id) into was_enrolled;
  blocked := p.status = 'refunded' or a.status in ('withdrawn','rejected');
  if not was_enrolled and not blocked and p_cohort_id is not null then
    select capacity into cap from public.cohorts where id=p_cohort_id;
    if p_reservation_id is not null then
      select * into r from public.checkout_reservations where id=p_reservation_id for update;
      blocked := not found or r.application_id<>p_application_id or r.user_id<>p_user_id or r.cohort_id<>p_cohort_id
        or r.stripe_session_id is distinct from p_session_id
        or (r.quote->>'amountCents')::integer<>p_amount_cents
        or r.status<>'active';
      -- A valid card payment made before expiry can arrive in a delayed webhook.
      -- Reclaim a lapsed hold only if capacity remains; never erase the money.
      if not blocked and coalesce(p_paid_at,now())>r.expires_at then blocked:=true; end if;
    end if;
    select (select count(*) from public.enrollments where cohort_id=p_cohort_id) +
      (select count(*) from public.checkout_reservations x where x.cohort_id=p_cohort_id and x.user_id<>p_user_id
        and x.status='active' and x.expires_at>now()
        and not exists(select 1 from public.enrollments e where e.cohort_id=x.cohort_id and e.user_id=x.user_id)) into occupied;
    if occupied>=cap then blocked:=true; end if;
  end if;
  if not blocked then
    if p_cohort_id is not null then
      insert into public.enrollments(user_id,cohort_id,application_id) values(p_user_id,p_cohort_id,p_application_id)
        on conflict(user_id,cohort_id) do nothing;
    end if;
    update public.applications set status = case when p_cohort_id is null then 'paid' else 'enrolled' end,
      paid_at = coalesce(a.paid_at,p_paid_at), stripe_payment_intent_id = p_payment_intent_id
      where id = p_application_id;
  end if;
  if p_reservation_id is not null then
    update public.checkout_reservations set status=case when blocked then 'released' else 'completed' end
      where id=p_reservation_id and application_id=p_application_id and user_id=p_user_id;
  end if;
  delete from public.payer_links where application_id=p_application_id and not blocked;
  return jsonb_build_object('newly_enrolled',not was_enrolled and not blocked,'blocked',blocked);
end $$;
revoke all on function public.settle_enrollment_payment(text,uuid,uuid,uuid,integer,text,text,text,timestamptz,uuid,integer) from public, anon, authenticated;
grant execute on function public.settle_enrollment_payment(text,uuid,uuid,uuid,integer,text,text,text,timestamptz,uuid,integer) to service_role;


notify pgrst,'reload schema';
