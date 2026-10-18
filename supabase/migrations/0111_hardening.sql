-- ============================================================================
-- 0111 — Moving a student no longer blocks writes that reference them, and
-- takes its locks in the order every checkout function does.
--
-- admin_move_student_cohort() (0103) serialises moves of one student by
-- locking their profile row first. It took that lock FOR UPDATE, the mode
-- that also conflicts with FOR KEY SHARE — the lock every foreign key check
-- takes on the row it points at. 137 foreign keys in production point at
-- public.profiles(id), so while a move was running, any other transaction
-- inserting a row for that student (a notification, an audit row, a chat
-- message, a payment) queued behind it.
--
-- FOR NO KEY UPDATE is enough. It conflicts with itself, so two moves of one
-- student still run one after the other, but not with FOR KEY SHARE, so
-- foreign key checks pass straight through. The move never updates the
-- profile row, so nothing it does needs the stronger mode. The enrollment
-- and application rows keep FOR UPDATE: the move then changes their
-- cohort_id, part of a unique key on both tables, which takes FOR UPDATE
-- whatever the select asked for.
--
-- The second change is the destination cohort. Every function that touches a
-- seat locks the cohort FOR UPDATE and then the application:
-- reserve_checkout_seat, attach_checkout_session and settle_enrollment_payment
-- (0081), and the refund settlement (0080). The move did it the other way
-- round. It locked the application, and only reached the cohort at the end,
-- through 0081's enrollment capacity guard (FOR UPDATE) and the foreign key
-- check on the new cohort_id (FOR KEY SHARE). So a Stripe settlement for that
-- student and cohort, holding the cohort and asking for the application,
-- could deadlock with an admin's move holding the application and asking for
-- the cohort. Postgres would abort one. That is exactly the "paid for this
-- cohort, enrolled in none" repair below meeting a webhook that is still
-- settling. The move's existing "does the cohort exist" read now takes that
-- lock up front, before the enrollment and the application, so both orders
-- are cohort then application. It held the same lock from the capacity guard
-- to commit anyway, so other writes to that cohort wait no longer than a
-- move's few statements.
--
-- (Under 0103 the profile lock was a second way into the same deadlock: a
-- settlement inserting the payment needs a key-share on the profile. FOR NO
-- KEY UPDATE removes that one.)
--
-- Not changed here: a full refund (apply_enrollment_refund, 0080) locks the
-- application and then deletes or re-points the enrollment, while the move
-- locks the enrollment and then the application, because it finds the
-- application through the enrollment. A refund for a student in the same
-- instant an admin moves them can still deadlock, as it could under 0103.
-- Postgres aborts one and its caller reports it: Stripe sends a failed
-- webhook again, and an admin sees the move or the refund fail and retries.
--
-- The function is 0103's, re-created with only those two lines (and their
-- comments) changed, so its result, its refusals and its rollbacks are the
-- same (lib/admin-integrity-migration-db.test.ts runs 0103's tests against
-- this version, and compares the two bodies). Same signature, so the code in
-- production before and after this deploy calls it the same way, and the
-- privileges are restated as 0103 left them.
--
-- If 0103 ever runs again after this file, run this file again: 0103
-- re-creates the old locks (0111's verify query notices).
--
-- Idempotent; safe to re-run. Changes no data. Assumes 0103.
-- ============================================================================

create or replace function public.admin_move_student_cohort(
  p_user_id uuid,
  p_to_cohort_id uuid,
  p_from_cohort_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.enrollments%rowtype;
  a public.applications%rowtype;
  clash public.applications%rowtype;
  has_enrollment boolean := false;
  has_application boolean := false;
  from_cohort uuid;
  moved_scholarships uuid[] := '{}';
  enrollment_change text := 'none';
  restore boolean := false;
begin
  -- One move per student at a time: a second click (or a second admin) waits
  -- here and then sees where the first one put them. FOR NO KEY UPDATE, not
  -- FOR UPDATE (0111): two of these still exclude each other, but a foreign
  -- key check on this profile (FOR KEY SHARE: any insert of a row that
  -- references the student) no longer has to wait for the move to commit.
  perform 1 from public.profiles where id = p_user_id for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;
  -- Locked now, before the enrollment and the application, rather than at the
  -- end by the capacity guard: every checkout function locks the cohort and
  -- then the application, and taking them the other way round could deadlock
  -- with a Stripe settlement for this student (0111).
  perform 1 from public.cohorts where id = p_to_cohort_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_cohort');
  end if;

  if p_from_cohort_id is not null then
    select * into e from public.enrollments
     where user_id = p_user_id and cohort_id = p_from_cohort_id
       for update;
    has_enrollment := found;
    -- The page showed them in that cohort and they aren't any more: someone
    -- else moved or removed them. Don't guess which enrollment was meant.
    if not has_enrollment then
      return jsonb_build_object('ok', false, 'code', 'stale');
    end if;
  else
    select * into e from public.enrollments
     where user_id = p_user_id
     order by enrolled_at desc, id
     limit 1
       for update;
    has_enrollment := found;
  end if;

  if has_enrollment then
    if e.application_id is not null then
      select * into a from public.applications
       where id = e.application_id and user_id = p_user_id
         for update;
      has_application := found;
    end if;
    if not has_application then
      select * into a from public.applications
       where user_id = p_user_id and cohort_id = e.cohort_id
         for update;
      has_application := found;
    end if;
  else
    -- No enrollment. A paid/enrolled application on the cohort picked first:
    -- that's the repair below, whichever application is newer. Else the
    -- application that holds access, else the newest.
    select * into a from public.applications
     where user_id = p_user_id
       and cohort_id = p_to_cohort_id
       and status in ('paid', 'enrolled')
       for update;
    has_application := found;
    if not has_application then
      select * into a from public.applications
       where user_id = p_user_id
       order by (status in ('paid', 'enrolled')) desc, created_at desc, id
       limit 1
         for update;
      has_application := found;
    end if;
  end if;

  if not has_enrollment and not has_application then
    return jsonb_build_object('ok', false, 'code', 'nothing_to_move');
  end if;

  from_cohort := case when has_enrollment then e.cohort_id else a.cohort_id end;
  -- Paid for this cohort and enrolled in none: not a move but a repair. Only
  -- reachable with no enrollment at all (a p_from_cohort_id that matched
  -- nothing returned 'stale' above), so there's no enrollment to clash with.
  restore := not has_enrollment
             and has_application
             and a.status in ('paid', 'enrolled')
             and a.cohort_id is not distinct from p_to_cohort_id;
  if from_cohort is not distinct from p_to_cohort_id and not restore then
    return jsonb_build_object('ok', false, 'code', 'same_cohort');
  end if;

  -- (user_id, cohort_id) is unique on both tables. Said plainly here rather
  -- than as a constraint violation halfway through.
  if has_enrollment and exists (
    select 1 from public.enrollments
     where user_id = p_user_id and cohort_id = p_to_cohort_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'already_enrolled');
  end if;
  if has_application and a.cohort_id is distinct from p_to_cohort_id then
    select * into clash from public.applications
     where user_id = p_user_id and cohort_id = p_to_cohort_id and id <> a.id;
    if found then
      return jsonb_build_object('ok', false, 'code', 'application_exists', 'status', clash.status);
    end if;
  end if;

  -- One award per student per cohort (0071's partial unique index). Checked
  -- up front to say so; the index still refuses a race, and rolls back. A
  -- restore stays in its cohort, so its award isn't a second one.
  if from_cohort is not null
     and not restore
     and exists (select 1 from public.scholarship_applications
                  where user_id = p_user_id and cohort_id = from_cohort and status = 'awarded')
     and exists (select 1 from public.scholarship_applications
                  where user_id = p_user_id and cohort_id = p_to_cohort_id and status = 'awarded')
  then
    return jsonb_build_object('ok', false, 'code', 'award_conflict');
  end if;

  -- The writes. Any of them raising undoes all of them.
  --
  -- Scholarship rows first, as moveToCohort always did. A scholarship follows
  -- the dates of the cohort on its row: the call window, the one-at-a-time
  -- rule, seat counts, the checkout discount lookup and the guest tickets'
  -- Demo Day all read scholarship_applications.cohort_id. Left on the old
  -- cohort, a deferred student's award would lock their mentor calls when the
  -- old cohort ended, although they're enrolled in the new one with calls
  -- unused, and would stop blocking a second award in the new one. Only rows
  -- on the cohort being left move: a returning student's award from an
  -- earlier cohort belongs to that cohort, and declined/withdrawn rows are a
  -- record of what was decided there. A restore leaves them where they are.
  if from_cohort is not null and not restore then
    with moved as (
      update public.scholarship_applications
         set cohort_id = p_to_cohort_id
       where user_id = p_user_id
         and cohort_id = from_cohort
         and status in ('draft', 'submitted', 'under_review', 'awarded')
      returning id
    )
    select coalesce(array_agg(id order by id), '{}') into moved_scholarships from moved;
  end if;

  if has_application and a.cohort_id is distinct from p_to_cohort_id then
    update public.applications set cohort_id = p_to_cohort_id where id = a.id;
  end if;

  if has_enrollment then
    -- Fires 0081's capacity guard (before update of cohort_id): a full
    -- cohort raises, and the student stays where they were.
    update public.enrollments
       set cohort_id = p_to_cohort_id, enrolled_at = now()
     where id = e.id;
    enrollment_change := 'moved';
  elsif has_application and a.status in ('paid', 'enrolled') then
    -- 0081's capacity guard fires on the insert too.
    insert into public.enrollments (user_id, cohort_id, application_id)
    values (p_user_id, p_to_cohort_id, a.id);
    enrollment_change := case when restore then 'restored' else 'created' end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'from_cohort_id', from_cohort,
    'to_cohort_id', p_to_cohort_id,
    'application_id', case when has_application then a.id end,
    'enrollment', enrollment_change,
    'scholarship_application_ids', to_jsonb(moved_scholarships)
  );
end $$;

comment on function public.admin_move_student_cohort(uuid, uuid, uuid) is
  'Moves one student''s enrollment, the application it belongs to and their live scholarship rows to another cohort in one transaction. Service role only; the app checks people.manage.';

revoke all on function public.admin_move_student_cohort(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_move_student_cohort(uuid, uuid, uuid) to service_role;
