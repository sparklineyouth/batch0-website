-- ============================================================================
-- 0077 — Stop users editing their own privileges.  *** SECURITY ***
--
-- APPLY THIS BEFORE 0076, AND BEFORE ANYTHING ELSE.
--
-- The hole
-- --------
-- `profiles self update` (0001) is:
--
--     create policy "profiles self update" on public.profiles
--       for update using (auth.uid() = id) with check (auth.uid() = id);
--
-- It restricts WHICH ROW you may update and says nothing about WHICH COLUMNS.
-- Postgres RLS cannot express "and don't touch role" — a policy has no access
-- to the OLD row — so there is nothing anywhere in migrations 0001..0076 that
-- stops a signed-in student writing `role = 'admin'` onto their own profile.
-- No guard trigger existed (the only BEFORE UPDATE trigger on the table is
-- `touch_profiles`, which just stamps `updated_at`), and no column privileges
-- were revoked.
--
-- `public.profiles` is exposed through PostgREST, and the anon key is in the
-- client bundle by design, so the whole exploit is one request a student can
-- paste into devtools:
--
--     PATCH /rest/v1/profiles?id=eq.<their own uid>
--     apikey: <NEXT_PUBLIC_SUPABASE_ANON_KEY>
--     Authorization: Bearer <their own access token>
--     {"role":"admin"}
--
-- This was confirmed against the live database with a throwaway account: the
-- request returns 200 and the row comes back with role 'admin'.
--
-- What that gets them: `capabilitiesForRole('admin')` is ['*'], so every
-- permission check in the app passes. The admin panel, applications,
-- payments, role management, the student list — and, because batch0 Live
-- derives host-vs-viewer from exactly this value, the entire webinar audience
-- (every watcher's name, id, and private signalling channel).
--
-- The fix
-- -------
-- A BEFORE UPDATE trigger, because it is the only thing that can see OLD and
-- NEW together. Ordinary edits are untouched — the one profile field the
-- browser is meant to write is `full_name`, and it stays writable.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

-- Columns a user must never change on their own row. Compared through
-- `to_jsonb` rather than named directly so this migration stays correct
-- across schema drift: a column that does not exist reads NULL on both sides
-- and simply never trips the guard, instead of failing to install.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
-- SECURITY DEFINER so the is_admin() lookup is not itself subject to the
-- caller's RLS; search_path is pinned so it cannot be hijacked by a
-- caller-controlled schema.
security definer
set search_path = public, pg_temp
as $$
declare
  guarded text[] := array[
    'id',
    'role',
    'email',
    'stripe_customer_id',
    -- A student who could write these could claim someone else's Discord
    -- identity and inherit whatever that link grants.
    'discord_user_id',
    'discord_username',
    'discord_linked_at'
  ];
  col text;
  old_j jsonb := to_jsonb(old);
  new_j jsonb := to_jsonb(new);
begin
  -- Server-side writes run under the service role, which has no `sub` claim,
  -- so auth.uid() is NULL. Every legitimate privileged write in this codebase
  -- goes through createAdminClient() (admin role changes, Stripe customer
  -- linking, Discord linking, the signup trigger), and they must keep working.
  if auth.uid() is null then
    return new;
  end if;

  -- A real admin editing through the browser is still allowed.
  if public.is_admin(auth.uid()) then
    return new;
  end if;

  foreach col in array guarded loop
    if (old_j ->> col) is distinct from (new_j ->> col) then
      raise exception
        'profiles.% cannot be changed by its owner', col
        using errcode = '42501',
              hint = 'Only an administrator (or the server) may change this field.';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.guard_profile_privileges() is
  'Blocks a signed-in user from editing privileged columns on their own profile row. RLS can only restrict WHICH ROW is updated, not which columns, so without this a student could PATCH role=admin over PostgREST with the public anon key.';

drop trigger if exists guard_profile_privileges on public.profiles;
create trigger guard_profile_privileges
  before update on public.profiles
  for each row execute procedure public.guard_profile_privileges();

-- ----------------------------------------------------------------------------
-- Belt and braces: take the column privilege away too.
--
-- The trigger is the real control. This is a second, independent layer, so a
-- future migration that drops or replaces the trigger does not silently
-- reopen the hole. `authenticated` keeps UPDATE on every other column, which
-- is what leaves the settings page (`full_name`) working.
--
-- Wrapped in a DO block because the exact column set varies with which
-- migrations have run, and a REVOKE naming a missing column would abort the
-- whole file.
-- ----------------------------------------------------------------------------
do $$
declare
  col text;
begin
  foreach col in array array[
    'role', 'email', 'stripe_customer_id',
    'discord_user_id', 'discord_username', 'discord_linked_at'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name = col
    ) then
      execute format(
        'revoke update (%I) on public.profiles from authenticated, anon', col
      );
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Repair: anyone who already took admin this way.
--
-- Deliberately NOT run automatically — it cannot tell a genuine admin from an
-- escalated one, and demoting a real admin locks the program out of its own
-- site. Run this first and look at the list:
--
--   select id, email, role, created_at from public.profiles
--    where role <> 'student' order by created_at desc;
--
-- Anyone there who should not be staff:
--
--   update public.profiles set role = 'student' where id = '<uuid>';
--
-- (That update is a service-role/SQL-editor write, so the new trigger allows
-- it.)
-- ----------------------------------------------------------------------------
