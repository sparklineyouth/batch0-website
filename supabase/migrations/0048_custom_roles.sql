-- ============================================================================
-- 0048 — Custom roles with per-role permissions.
--
-- Until now `profiles.role` was a CHECK constraint over four hard-coded
-- strings, and "admin" meant "can do literally everything". This turns roles
-- into data: `app_roles` rows own a permission list, `profiles.role` becomes a
-- foreign key into them, and admins can mint new roles (intern, ops, TA, …)
-- from /admin/roles without a deploy.
--
-- The four original roles are seeded as system rows, so nothing about existing
-- behaviour changes on the way through: `admin` keeps the '*' wildcard,
-- `mentor` keeps staff powers, `investor` keeps the investor panel, `student`
-- keeps the dashboard. A fifth role, `intern`, ships pre-configured.
--
-- Permission strings are defined in lib/permissions.ts — keep the seed below
-- in sync with that catalog.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0047 are applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_roles
-- ----------------------------------------------------------------------------
create table if not exists public.app_roles (
  slug        text primary key,
  label       text not null,
  description text,
  -- Permission keys from lib/permissions.ts. '*' is the wildcard grant.
  permissions text[] not null default '{}',
  -- Where members of this role land after sign-in. Validated in the app
  -- against ROLE_HOME_OPTIONS; a role that can't reach its home falls back.
  home_path   text not null default '/dashboard',
  -- Badge colour token, resolved to classes by roleColorClasses().
  color       text not null default 'slate',
  -- System roles are referenced by slug throughout the codebase. They can be
  -- re-permissioned but never renamed or deleted.
  is_system   boolean not null default false,
  -- Display order in the admin UI and role pickers.
  rank        integer not null default 100,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Slugs are used in URLs (/admin/roles/<slug>) and compared in code.
alter table public.app_roles drop constraint if exists app_roles_slug_format;
alter table public.app_roles
  add constraint app_roles_slug_format
  check (slug ~ '^[a-z][a-z0-9-]{1,31}$');

create or replace function public.touch_app_roles_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_roles_touch_updated_at on public.app_roles;
create trigger app_roles_touch_updated_at
  before update on public.app_roles
  for each row execute procedure public.touch_app_roles_updated_at();

-- ----------------------------------------------------------------------------
-- Seed: the four system roles, at exactly the power they have today.
--
-- `on conflict … do update` only resets the identity columns (label, system
-- flag, ordering) — NOT `permissions`. Re-running the migration must never
-- undo permission edits an admin has since made in the UI.
-- ----------------------------------------------------------------------------
insert into public.app_roles
  (slug, label, description, permissions, home_path, color, is_system, rank)
values
  (
    'student',
    'Student',
    'Takes part in the programme. The default role for every new account.',
    array['student.dashboard'],
    '/dashboard',
    'slate',
    true,
    10
  ),
  (
    'admin',
    'Admin',
    'Full control over everything, including roles and permissions.',
    array['*'],
    '/admin',
    'phosphor',
    true,
    20
  ),
  (
    'mentor',
    'Mentor',
    'Works with students and teams: check-ins, office hours, course feedback.',
    array['mentor.panel'],
    '/mentor',
    'emerald',
    true,
    30
  ),
  (
    'investor',
    'Investor',
    'Browses teams, attends Demo Day, and requests introductions.',
    array['investor.panel'],
    '/investor',
    'purple',
    true,
    40
  )
on conflict (slug) do update set
  label     = excluded.label,
  is_system = true,
  rank      = excluded.rank;

-- The intern role. Ships with a read-mostly, no-money, no-escalation set;
-- admins widen or narrow it at /admin/roles. Seeded only if it doesn't exist,
-- so a re-run never stomps a customised intern.
insert into public.app_roles
  (slug, label, description, permissions, home_path, color, is_system, rank)
values
  (
    'intern',
    'Intern',
    'Helps run the programme day to day. Can see applicants and people, and owns challenges, resources, events, and announcements. No money, no role changes.',
    array[
      'applications.view',
      'people.view',
      'challenges.manage',
      'resources.manage',
      'events.manage',
      'announcements.manage',
      'pulse.view'
    ],
    '/admin',
    'amber',
    false,
    50
  )
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- profiles.role: CHECK constraint → foreign key
-- ----------------------------------------------------------------------------

-- Any row holding a value that predates the seed (e.g. a stray 'teacher' or
-- 'professor' from before 0007) would block the FK. Park those on 'student'.
update public.profiles p
set role = 'student'
where not exists (select 1 from public.app_roles r where r.slug = p.role);

alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles drop constraint if exists profiles_role_fkey;
alter table public.profiles
  add constraint profiles_role_fkey
  foreign key (role) references public.app_roles(slug)
  on update cascade
  on delete restrict;

-- Role filters and per-role counts scan this on every admin page load.
create index if not exists profiles_role_idx on public.profiles (role);

-- ----------------------------------------------------------------------------
-- Permission helpers
-- ----------------------------------------------------------------------------

-- The permission list for a user, or '{}' when they have no profile.
create or replace function public.user_permissions(uid uuid)
returns text[]
language sql
stable
security definer set search_path = public
as $$
  select coalesce(r.permissions, '{}'::text[])
  from public.profiles p
  join public.app_roles r on r.slug = p.role
  where p.id = uid;
$$;

-- True when the user's role carries `perm`, or the '*' wildcard.
create or replace function public.has_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.app_roles r on r.slug = p.role
    where p.id = uid
      and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
  );
$$;

-- ----------------------------------------------------------------------------
-- Rewire the RLS role predicates onto permissions.
--
-- These gate row-level access across ~40 policies from 0001–0047. Each keeps
-- the exact membership it had before — the seed above is what makes that true
-- — but now a custom role can opt into the same access by holding the
-- permission, instead of the predicate being a hard-coded list of slugs.
--
-- Deliberately conservative: is_admin() stays tied to the wildcard, so minting
-- an intern never silently widens row-level access to financial or audit data.
-- ----------------------------------------------------------------------------

-- Was: role in ('admin','teacher')
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.app_roles r on r.slug = p.role
    where p.id = uid and r.permissions @> array['*']::text[]
  );
$$;

-- Was: role in ('admin','mentor')
create or replace function public.is_staff(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.has_permission(uid, 'mentor.panel');
$$;

-- Was: role in ('mentor','admin')
create or replace function public.is_mentor(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.has_permission(uid, 'mentor.panel');
$$;

-- Was: role in ('investor','admin')
create or replace function public.is_investor(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.has_permission(uid, 'investor.panel');
$$;

-- ----------------------------------------------------------------------------
-- RLS
--
-- Roles are not secret — the middleware reads the signed-in user's row on
-- every request with the anon key, and role badges render in the UI. Reads are
-- open to any signed-in user; writes only ever happen through the service-role
-- client behind the roles.manage permission check in the app.
-- ----------------------------------------------------------------------------
alter table public.app_roles enable row level security;

drop policy if exists "app_roles readable by signed-in users" on public.app_roles;
create policy "app_roles readable by signed-in users" on public.app_roles
  for select using (auth.role() = 'authenticated');

drop policy if exists "app_roles writable by admins" on public.app_roles;
create policy "app_roles writable by admins" on public.app_roles
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
