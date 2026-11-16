-- Issue completion certificates to every enrolled student in the Fall cohort.
--
-- Run this in the Supabase SQL editor (production). It is idempotent: a
-- student who already has a certificate for this cohort is skipped, so it is
-- safe to re-run after adding late enrollments.
--
-- Codes match lib/cert.ts: 10 chars from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ
-- (no O/0 or I/1), unique across the table. Each student also gets the same
-- "certificate_issued" notification the old bulk-issue action sent, linking to
-- /verify/<code>.

-- ---------------------------------------------------------------------------
-- STEP 1 — Confirm which cohort this will hit. Run this on its own first.
-- ---------------------------------------------------------------------------
select
  c.id,
  c.name,
  c.status,
  c.starts_on,
  c.ends_on,
  (select count(*) from public.enrollments e where e.cohort_id = c.id) as enrolled,
  (select count(*) from public.certificates ct where ct.cohort_id = c.id) as certs_already
from public.cohorts c
order by c.starts_on desc nulls last;

-- ---------------------------------------------------------------------------
-- STEP 2 — Issue. Edit the cohort name below to the exact name from step 1.
-- ---------------------------------------------------------------------------
do $$
declare
  -- <<< set this to the Fall cohort's exact name from step 1 >>>
  v_cohort_name  constant text := 'Fall 2026';
  v_alpha        constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_cohort_id    uuid;
  r              record;
  v_code         text;
  v_tries        int;
  v_issued       int := 0;
begin
  select id into v_cohort_id
  from public.cohorts
  where name = v_cohort_name;

  if v_cohort_id is null then
    raise exception 'No cohort named "%". Re-run step 1 and fix the name.', v_cohort_name;
  end if;

  for r in
    select e.user_id
    from public.enrollments e
    where e.cohort_id = v_cohort_id
      and not exists (
        select 1
        from public.certificates c
        where c.user_id = e.user_id
          and c.cohort_id = v_cohort_id
      )
  loop
    v_tries := 0;
    loop
      v_tries := v_tries + 1;
      if v_tries > 10 then
        raise exception 'Could not find a free certificate code for user %', r.user_id;
      end if;

      select string_agg(
               substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1),
               ''
             )
        into v_code
      from generate_series(1, 10);

      begin
        insert into public.certificates (user_id, cohort_id, code)
        values (r.user_id, v_cohort_id, v_code);
        exit;  -- inserted cleanly
      exception when unique_violation then
        null;  -- code collision, draw another
      end;
    end loop;

    insert into public.notifications (user_id, type, title, body, link)
    values (
      r.user_id,
      'certificate_issued',
      'Your batch0 certificate is ready',
      'Tap to view + share.',
      '/verify/' || v_code
    );

    v_issued := v_issued + 1;
  end loop;

  raise notice 'Issued % new certificate(s) for %', v_issued, v_cohort_name;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 3 — Verify. Every enrolled student should have a code; spot-check one
-- at https://<site>/verify/<code>.
-- ---------------------------------------------------------------------------
select
  p.full_name,
  p.email,
  ct.code,
  ct.issued_at,
  '/verify/' || ct.code as verify_path
from public.enrollments e
join public.cohorts c on c.id = e.cohort_id
join public.profiles p on p.id = e.user_id
left join public.certificates ct
  on ct.user_id = e.user_id and ct.cohort_id = e.cohort_id
where c.name = 'Fall 2026'   -- same name as step 2
order by (ct.code is null) desc, p.full_name;
