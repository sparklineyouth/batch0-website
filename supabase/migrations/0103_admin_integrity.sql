-- ============================================================================
-- 0103 — Admin integrity: moving a student is one transaction, and the site
-- always keeps a full admin.
--
-- 1. admin_move_student_cohort()
-- ------------------------------
-- "Move to a different cohort" (moveToCohort in
-- app/admin/students/[id]/actions.ts) used to be five separate PostgREST
-- writes: restamp the scholarship rows, move the latest application, DELETE
-- every enrollment, then INSERT one back only when that application was
-- paid/enrolled. So:
--
--   - a student added with "Add a person" (an enrollment, no application)
--     lost their enrollment and the action reported success;
--   - a student whose newest application was a draft for another cohort lost
--     their enrollment too, and the draft moved instead of the paid one;
--   - when the INSERT failed (the cohort was full: 0081's capacity trigger),
--     the DELETE had already happened, and the action still said "Moved";
--   - a returning student lost every earlier cohort's enrollment, not just
--     the one being moved.
--
-- This function is the whole move, in the one transaction PostgREST wraps an
-- RPC call in: any write that fails (a full cohort, an active checkout on the
-- application — 0081's guards — or the one-award-per-cohort index, 0071)
-- raises, and nothing is left half-moved. The app writes the audit row and
-- notifies the student only after it returns, i.e. after commit.
--
-- What moves:
--   - the enrollment: the one in p_from_cohort_id (the cohort the profile
--     showed), or the newest one. Updated in place, so it keeps its
--     application_id (a refund still finds it, 0080) and needs no
--     application at all; enrolled_at restarts, as it did before, because
--     assignments in the new cohort count from when the student joined it;
--   - the application that enrollment belongs to (its application_id, else
--     the student's application on that cohort). With no enrollment, the
--     application that holds access (paid/enrolled) before the newest one,
--     and a paid one gets its missing enrollment back in the new cohort;
--   - their live scholarship rows on the cohort being left (the rule
--     moveToCohort already had: declined/withdrawn rows stay where they were
--     decided).
-- Nothing else: other enrollments, other applications (a newer draft for some
-- other cohort stays a draft for that cohort), payments (the ledger records
-- what was bought) and certificates stay as they are.
--
-- Refusals an admin has to act on come back as {ok: false, code} before any
-- write, so the message can say what to do.
--
-- 2. keep_a_full_admin
-- --------------------
-- Role changes could remove the last full admin: the email form exempted full
-- admins from "you can't change your own role", and a delegated role manager
-- could demote a full admin from the People list. The app now refuses both
-- (lib/role-change.ts), and these triggers make "at least one person holds a
-- '*' role" true in the database whatever writes the row: a profile losing
-- full access, a full admin's profile being deleted, or a '*' role losing the
-- wildcard. Every such change takes one transaction-scoped advisory lock
-- before counting who is left, so two admins demoting each other at the same
-- moment are serialised: the second one counts after the first has committed,
-- and is refused.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run. Changes no data.
-- Assumes 0048 (app_roles), 0071 (scholarship_applications) and 0081
-- (the enrollment and application guards).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Move a student to another cohort, atomically.
-- ----------------------------------------------------------------------------
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
begin
  -- One move per student at a time: a second click (or a second admin) waits
  -- here and then sees where the first one put them.
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;
  perform 1 from public.cohorts where id = p_to_cohort_id;
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
    -- No enrollment: the application that holds access, else the newest.
    select * into a from public.applications
     where user_id = p_user_id
     order by (status in ('paid', 'enrolled')) desc, created_at desc, id
     limit 1
       for update;
    has_application := found;
  end if;

  if not has_enrollment and not has_application then
    return jsonb_build_object('ok', false, 'code', 'nothing_to_move');
  end if;

  from_cohort := case when has_enrollment then e.cohort_id else a.cohort_id end;
  if from_cohort is not distinct from p_to_cohort_id then
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
  -- up front to say so; the index still refuses a race, and rolls back.
  if from_cohort is not null
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
  -- record of what was decided there.
  if from_cohort is not null then
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
    insert into public.enrollments (user_id, cohort_id, application_id)
    values (p_user_id, p_to_cohort_id, a.id);
    enrollment_change := 'created';
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

-- ----------------------------------------------------------------------------
-- 2. Somebody always keeps full access.
-- ----------------------------------------------------------------------------
create or replace function public.keep_a_full_admin()
returns trigger
language plpgsql
-- SECURITY DEFINER so the count isn't narrowed by the caller's RLS (an admin
-- editing from the browser); search_path pinned so it can't be hijacked.
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;
  -- Only a change that takes full access away from someone matters.
  if not exists (select 1 from public.app_roles
                  where slug = old.role and permissions @> array['*']::text[]) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and exists (select 1 from public.app_roles
                                   where slug = new.role and permissions @> array['*']::text[]) then
    return new;
  end if;

  -- Serialise every change that removes full access. Under READ COMMITTED the
  -- count below then runs on a snapshot taken after any concurrent removal
  -- has committed, so two admins demoting each other can't both succeed. In
  -- one statement that demotes several, rows already processed are visible
  -- here, so the last of them is refused (and the statement with it).
  perform pg_advisory_xact_lock(hashtext('batch0:full-admins'));
  if not exists (
    select 1
      from public.profiles p
      join public.app_roles r on r.slug = p.role
     where p.id <> old.id
       and r.permissions @> array['*']::text[]
  ) then
    raise exception 'batch0 needs at least one full admin, and this would leave none.'
      using errcode = '23514',
            hint = 'Make someone else a full admin first.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

comment on function public.keep_a_full_admin() is
  'Refuses a profile update or delete that would leave no profile holding a role with the ''*'' wildcard. Serialised with an advisory lock so concurrent demotions cannot both pass.';

drop trigger if exists keep_a_full_admin on public.profiles;
create trigger keep_a_full_admin
  before update of role or delete on public.profiles
  for each row execute function public.keep_a_full_admin();

create or replace function public.keep_a_full_admin_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (old.permissions @> array['*']::text[])
     or new.permissions @> array['*']::text[] then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('batch0:full-admins'));
  -- An empty role losing the wildcard takes access from nobody.
  if exists (select 1 from public.profiles where role = old.slug)
     and not exists (
       select 1
         from public.profiles p
         join public.app_roles r on r.slug = p.role
        where r.slug <> old.slug
          and r.permissions @> array['*']::text[]
     ) then
    raise exception 'batch0 needs at least one full admin, and this would leave none.'
      using errcode = '23514',
            hint = 'Give someone a role with full access first.';
  end if;
  return new;
end $$;

comment on function public.keep_a_full_admin_role() is
  'Refuses removing the ''*'' wildcard from a role when its members are the only full admins.';

drop trigger if exists keep_a_full_admin_role on public.app_roles;
create trigger keep_a_full_admin_role
  before update of permissions on public.app_roles
  for each row execute function public.keep_a_full_admin_role();

-- Trigger functions can't be called directly; nobody needs EXECUTE on them.
revoke all on function public.keep_a_full_admin() from public, anon, authenticated;
revoke all on function public.keep_a_full_admin_role() from public, anon, authenticated;

notify pgrst, 'reload schema';
