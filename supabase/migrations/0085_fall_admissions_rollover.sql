-- Fall remains joinable through September 30, then new admissions select the
-- next eligible intake. Do not change Fall's active status, calendar, existing
-- applications or enrollments: participants retain their course access.
begin;
do $$ begin
  if exists(select 1 from public.cohorts
    where id='6350c6ac-70f0-4f53-93d5-c99e397185a9'
      and (starts_on is distinct from date '2026-09-14'
        or ends_on is distinct from date '2026-11-13')) then
    raise exception 'Fall calendar differs from the approved September 14–November 13 offer';
  end if;
end $$;

update public.cohorts set
  applications_close_at='2026-09-30 23:59:59.999-04'::timestamptz,
  late_entry_until='2026-09-30 23:59:59.999-04'::timestamptz,
  catch_up_plan='Late entrants review the Week 1 field guide and Week 2 customer-interview work, then contact hello@batch0.org to agree catch-up priorities and join the next session listed in Events. Earlier session recordings are not promised.'
where id='6350c6ac-70f0-4f53-93d5-c99e397185a9';

commit;
