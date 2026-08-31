-- ============================================================================
-- 0053 — Resource opens, so "where did they stop?" has an answer.
--
-- Course lessons, flows, challenges and assignments all already record
-- progress: `lesson_progress` has watched_seconds and completed_at,
-- `flow_progress` even stores `current_step`, which is literally the step a
-- student is sitting on. Resources were the hole — they render as plain <a>
-- links to a signed storage URL or an external site, so opening one left no
-- trace anywhere.
--
-- One row per (student, resource) rather than one per click: the useful
-- questions are "has this student opened the pre-work?" and "when did they
-- last look at it?", not "how many times did they click on Tuesday". Keeping
-- it collapsed means the table stays roughly roster-sized instead of growing
-- without bound, and the admin progress view can join it directly.
--
-- Run in Supabase SQL Editor (or `supabase db push`). Idempotent.
-- ============================================================================

create table if not exists public.resource_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  -- Cheap engagement signal: a resource opened once and never returned to
  -- reads differently from one opened eight times.
  view_count integer not null default 1,
  primary key (user_id, resource_id)
);

-- "What has this student opened, most recent first" — the student-detail page.
create index if not exists resource_views_user_idx
  on public.resource_views (user_id, last_viewed_at desc);
-- "Who has opened this resource" — the per-resource reach column.
create index if not exists resource_views_resource_idx
  on public.resource_views (resource_id);

-- ---------------------------------------------------------------------------
-- Recording a view
--
-- A plain upsert can't increment: `on conflict do update` needs to read the
-- existing count, which PostgREST's upsert doesn't express. A function keeps
-- it to one round trip and one statement, so two tabs opening the same
-- resource at once can't lose a count to a read-modify-write race.
--
-- SECURITY DEFINER with a pinned search_path so it can be called by the
-- signed-in student directly — the row it writes is always their own, taken
-- from auth.uid() rather than from an argument, so it can't be used to forge
-- someone else's activity.
-- ---------------------------------------------------------------------------
create or replace function public.record_resource_view(p_resource_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into public.resource_views (user_id, resource_id)
  values (auth.uid(), p_resource_id)
  on conflict (user_id, resource_id) do update
    set last_viewed_at = now(),
        view_count = public.resource_views.view_count + 1;
end;
$$;

grant execute on function public.record_resource_view(uuid) to authenticated;

alter table public.resource_views enable row level security;

-- A student may read their own history; admins read everyone's. Writes go
-- exclusively through the function above, so there is no INSERT/UPDATE policy
-- on purpose — nothing should be able to hand-write a view row.
drop policy if exists "resource_views self read" on public.resource_views;
create policy "resource_views self read" on public.resource_views
  for select using (auth.uid() = user_id);

drop policy if exists "resource_views admin read" on public.resource_views;
create policy "resource_views admin read" on public.resource_views
  for select using (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
