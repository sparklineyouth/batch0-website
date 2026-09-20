-- User confirmed Sep20: preserve the advertised Sep14-Nov13 nine-week program,
-- allow late entry through Sep22 with catch-up support. No notifications sent.
begin;
do $$ begin
 if exists(select 1 from public.cohorts where id='6350c6ac-70f0-4f53-93d5-c99e397185a9'
  and (starts_on<>date '2026-09-14' or ends_on<>date '2026-11-13')) then
  raise exception 'Fall dates differ from the approved nine-week offer';
 end if;
end $$;

update public.cohorts set
 applications_close_at='2026-09-22 23:59:59-04'::timestamptz,
 late_entry_until='2026-09-22 23:59:59-04'::timestamptz,
 catch_up_plan='Late entrants complete the Week 1 field guide and first customer-interview plan, then receive catch-up help from the team. The intro and catch-up session is September 21, 1–2 p.m. Eastern. If you enroll afterward or cannot attend, contact hello@batch0.org to arrange catch-up support before continuing with Week 2.'
where id='6350c6ac-70f0-4f53-93d5-c99e397185a9';

-- The original course dates are preserved in the stable, server-created room
-- names. Use those dates, not the sequential Sunday labels from0069.
with original as(
 select id,type,to_date(substring(daily_room_name from '-([0-9]{8})-'),'YYYYMMDD') as day
 from public.events
 where cohort_id='6350c6ac-70f0-4f53-93d5-c99e397185a9'
 and daily_room_name ~ '^b0-6350c6ac-(ws|oh|demo)-[0-9]{8}-'
), plan as(
 select *, (day+time '20:00') at time zone 'America/New_York' as start from original
 where day between date '2026-09-21' and date '2026-11-13'
)
update public.events e set starts_at=p.start,
 ends_at=p.start+case when e.type='office_hours' then interval '30 minutes' else interval '1 hour' end,
 title=regexp_replace(e.title,'^Week [0-9]+ Webinar [—–-] ','','i'),updated_at=now()
from plan p where e.id=p.id;

update public.events set title='Intro call and catch-up orientation — Finding a Problem Worth Building',
 description='Meet the team, turn an everyday problem into a first testable idea, and find the Week 1 field guide. Late entrants receive a clear catch-up plan before Week 2. Bring your questions to the private written Q&A panel. If you cannot attend or enroll after this session, contact hello@batch0.org for catch-up support. This is a staff-led broadcast; student microphones and screen sharing are not enabled.',updated_at=now()
where id='a1ab2a89-6cde-504c-9b17-857a683549eb' and cohort_id='6350c6ac-70f0-4f53-93d5-c99e397185a9';

update public.cohort_kickoff set
 headline='Joining Fall: your first steps',
 intro='Fall runs September 14–November 13. Late entry is open through September 22 with catch-up support. Start with the Week 1 field guide, then join the team for the intro and catch-up session or contact us for help getting ready for Week 2.',
 time_label='Intro and catch-up: Monday, September 21 · 1–2 p.m. Eastern. Workshops: Mondays 8–9 p.m.; office hours: Thursdays 8–8:30 p.m. Eastern.',
 join_url='https://batch0.org/dashboard/events/a1ab2a89-6cde-504c-9b17-857a683549eb/live',
 agenda='[{"title":"Welcome and the nine-week plan","body":"Meet the team and review the path from a customer problem to a working project and final showcase."},{"title":"Find a problem to test","body":"Use the Week 1 field guide to turn an observation into an interview plan."},{"title":"Catch up and ask questions","body":"Review Course, the next workshop, and your first deliverable. Ask questions in private written Q&A."}]'::jsonb,
 checklist='[{"href":"/dashboard/course","label":"Open the Week 1 field guide"},{"href":"/dashboard/events","label":"See the corrected live schedule"},{"href":"/parents","label":"Share the parent guide"},{"href":"/api/events/a1ab2a89-6cde-504c-9b17-857a683549eb/ics","label":"Add the intro and catch-up session to your calendar"}]'::jsonb,
 note='If you miss the intro or join on September 22, email hello@batch0.org for catch-up support. Your dashboard calendar is the current schedule. Demo Day is a staff-led showcase with moderated written Q&A.',updated_at=now()
where cohort_id='6350c6ac-70f0-4f53-93d5-c99e397185a9';

do $$ begin
 if exists(select 1 from public.events e join public.cohorts c on c.id=e.cohort_id
 where c.id='6350c6ac-70f0-4f53-93d5-c99e397185a9'
 and (e.starts_at at time zone 'America/New_York')::date>c.ends_on) then
 raise exception 'A Fall event remains beyond the program end; review before applying';
 end if;
end $$;
commit;
