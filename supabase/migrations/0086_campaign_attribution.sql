-- Private, first-party source labels. No Google identifiers or student identity
-- are exported to an advertising platform. The existing payment ledger joins
-- by application_id even when a parent pays from an unrelated device.
create table if not exists public.application_attributions (
  application_id uuid primary key references public.applications(id) on delete cascade,
  source text not null check (source = 'google'),
  medium text not null check (medium = 'cpc'),
  campaign text not null check (campaign ~ '^batch0_[a-z0-9_-]{1,80}$'),
  landing_path text not null check (landing_path in ('/', '/parents', '/program', '/sample-lesson', '/apply', '/start')),
  first_touch_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
alter table public.application_attributions enable row level security;
revoke all on public.application_attributions from public, anon, authenticated;
grant select, insert on public.application_attributions to service_role;

-- A later ad click cannot claim an application that already existed. Skip the
-- attribution only, preserving the student's application and any older source.
create or replace function public.guard_application_attribution()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.first_touch_at > now() or new.first_touch_at <= now() - interval '30 days'
    or exists (select 1 from public.applications a where a.id = new.application_id and a.created_at < new.first_touch_at)
  then return null;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_application_attribution() from public, anon, authenticated;
drop trigger if exists guard_application_attribution on public.application_attributions;
create trigger guard_application_attribution before insert on public.application_attributions
for each row execute function public.guard_application_attribution();

-- Aggregate payments before joining applications: retries and multiple captures
-- must not multiply the application count. Enrollment/free seats aren't revenue.
create or replace view public.campaign_attribution_report with (security_invoker = true) as
with cash as (
  select application_id,
    coalesce(sum(amount_cents) filter (where status in ('succeeded', 'paid', 'refunded') and lower(coalesce(currency, 'usd')) = 'usd'), 0) as captured_cents,
    coalesce(sum(least(amount_cents, greatest(0, case when status = 'refunded' then amount_cents else coalesce(amount_refunded_cents, 0) end)))
      filter (where status in ('succeeded', 'paid', 'refunded') and lower(coalesce(currency, 'usd')) = 'usd'), 0) as refunded_cents,
    count(*) filter (where status in ('succeeded', 'paid', 'refunded') and lower(coalesce(currency, 'usd')) <> 'usd') as other_currency_payments
  from public.payments group by application_id
)
select t.source, t.medium, t.campaign, a.cohort_id,
  count(*) as applications_started,
  count(*) filter (where a.submitted_at is not null) as applications_submitted,
  count(*) filter (where coalesce(c.captured_cents - c.refunded_cents, 0) > 0) as paid_applications,
  coalesce(sum(c.captured_cents), 0) as captured_cents,
  coalesce(sum(c.refunded_cents), 0) as refunded_cents,
  coalesce(sum(c.captured_cents - c.refunded_cents), 0) as retained_cents,
  coalesce(sum(c.other_currency_payments), 0) as other_currency_payments
from public.application_attributions t
join public.applications a on a.id = t.application_id
left join cash c on c.application_id = t.application_id
group by t.source, t.medium, t.campaign, a.cohort_id;
revoke all on public.campaign_attribution_report from public, anon, authenticated;
grant select on public.campaign_attribution_report to service_role;
