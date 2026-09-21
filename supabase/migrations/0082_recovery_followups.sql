-- Preparing recovery is not authorization to send. Keep the old campaign paused,
-- retain its history, and make current copy safe for a deliberate future send.
begin;
alter table public.applications add column if not exists followup_paused boolean not null default false;
-- Staff notes must not live on applications: students can select their own row.
create or replace function public.guard_followup_pause() returns trigger language plpgsql set search_path=public as $$
begin
 if auth.role()='authenticated' then
  if tg_op='INSERT' then new.followup_paused:=false;
  else new.followup_paused:=old.followup_paused; end if;
 end if;
 return new;
end $$;
drop trigger if exists guard_followup_pause on public.applications;
create trigger guard_followup_pause before insert or update on public.applications
for each row execute function public.guard_followup_pause();

create table if not exists public.recovery_followups(
 application_id uuid primary key references public.applications(id) on delete cascade,
 note text not null default '' check(length(note)<=2000),
 contacted_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.recovery_followups enable row level security;
revoke all on public.recovery_followups from anon,authenticated;
grant all on public.recovery_followups to service_role;

insert into public.email_template_versions(template_id,version,subject,preheader,body_html,cta_label,cta_url,variables)
select id,version,subject,preheader,body_html,cta_label,cta_url,variables
from public.email_templates where key='nudge.unpaid'
on conflict(template_id,version) do nothing;

update public.email_templates set
 subject='Any questions about joining batch0, {{first_name}}?',
 preheader='The schedule, parent guide, and your next step.',
 body_html='<p>Hi {{first_name}},</p><p>You were accepted to <strong>{{cohort_name}}</strong>. Is the schedule, a parent question, the cost, or checkout holding you back?</p><p><a href="{{site_url}}/parents">The parent guide</a> explains the live schedule, sample work, and how enrollment works. Your enrollment page shows your current total and availability before payment. A seat is confirmed only when enrollment is complete.</p><p>Reply with the main question and we will answer it directly. If the timing no longer works, tell us and we will stop following up.</p>',
 cta_label='Review enrollment',cta_url='{{site_url}}/dashboard/accepted',
 version=version+1,updated_at=now()
where key='nudge.unpaid' and subject is distinct from 'Any questions about joining batch0, {{first_name}}?';

update public.email_automations set enabled=false,trigger_type='manual',schedule_cron=null,
 name='Fall enrollment follow-up — manual review',
 description='Review the parent-ready recovery list before any send. Confirm interest, price and available seats. No daily repeat. Stop on payment, withdrawal, a support issue or request not to follow up.',
 audience='{"segment":"accepted","cohortId":"6350c6ac-70f0-4f53-93d5-c99e397185a9","includeParents":true}'::jsonb,
 dedupe_window_hours=72,updated_at=now()
where id='63c50182-e879-4dcc-bccf-3a5b2c34e343';

update public.email_outbox set status='skipped',last_error='Paused for parent-ready recovery review; no message sent',updated_at=now()
where template_id in(select id from public.email_templates where key='nudge.unpaid')
 and status in('pending','failed');
commit;
