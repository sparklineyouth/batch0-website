-- ============================================================================
-- 0044 — "Before One": interactive pre-cohort flows + build receipts.
--
-- Flows are admin-curated, multi-step interactive experiences (diagnostics,
-- challenges, guided worksheets) — the personalized layer of the pre-cohort
-- resources. A flow is a sequence of steps (content / choice / input /
-- checklist / outcome); choice options can jump to any step, which is how a
-- flow branches ("no idea yet" vs "already building"). Students' answers and
-- position live in flow_progress, one row per (flow, user).
--
-- Build receipts are the proof-of-work feed: students post evidence
-- (interviews done, landing pages live, killed ideas) visible to their
-- cohort. Credibility for evidence, not likes.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0043 applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  tagline text,
  -- Which shelf of the pre-cohort hub the flow sits on.
  stage text not null default 'explore'
    check (stage in ('explore', 'prove', 'prepare')),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  est_minutes integer,
  sort_order integer not null default 0,
  -- null = ships with every cohort (like global resources).
  cohort_id uuid references public.cohorts(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flow_steps (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows(id) on delete cascade,
  -- Stable identifier inside the flow: branch targets and answer keys point
  -- at step_key, so reordering steps never breaks branching or answers.
  step_key text not null,
  title text,
  kind text not null
    check (kind in ('content', 'choice', 'input', 'checklist', 'outcome')),
  -- Markdown body shown above the step's interaction.
  body text,
  -- Kind-specific shape (options / fields / items / blocks / next). See
  -- lib/flows.ts for the TypeScript source of truth.
  config jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  unique (flow_id, step_key)
);

create index if not exists flow_steps_flow_idx
  on public.flow_steps (flow_id, sort_order);

create table if not exists public.flow_progress (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- step_key -> answer (choice value, {field: text}, or checked item keys).
  answers jsonb not null default '{}'::jsonb,
  current_step text,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (flow_id, user_id)
);

create table if not exists public.build_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The poster's cohort at post time; the feed is cohort-visible.
  cohort_id uuid references public.cohorts(id) on delete set null,
  kind text not null check (kind in (
    'interview', 'landing_page', 'users', 'experiment',
    'pivot', 'kill', 'ship', 'other'
  )),
  body text not null,
  link_url text,
  created_at timestamptz not null default now()
);

create index if not exists build_receipts_cohort_idx
  on public.build_receipts (cohort_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.flows enable row level security;
alter table public.flow_steps enable row level security;
alter table public.flow_progress enable row level security;
alter table public.build_receipts enable row level security;

-- Flows: staff see everything (including drafts). Students see published
-- flows scoped to their cohort (or global) once accepted / paid / enrolled —
-- same audience as pre-cohort resources (0042), no date condition.
drop policy if exists "flows read" on public.flows;
create policy "flows read" on public.flows
  for select using (
    public.is_staff(auth.uid())
    or (
      status = 'published'
      and (
        exists (
          select 1 from public.enrollments e
          where e.user_id = auth.uid()
            and (flows.cohort_id is null or e.cohort_id = flows.cohort_id)
        )
        or exists (
          select 1 from public.applications a
          where a.user_id = auth.uid()
            and a.status in ('accepted', 'paid', 'enrolled')
            and (flows.cohort_id is null or a.cohort_id = flows.cohort_id)
        )
      )
    )
  );

drop policy if exists "flows admin write" on public.flows;
create policy "flows admin write" on public.flows
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Steps inherit the parent flow's visibility: the subquery runs under the
-- caller's RLS, so a step is readable exactly when its flow is.
drop policy if exists "flow steps read" on public.flow_steps;
create policy "flow steps read" on public.flow_steps
  for select using (
    exists (select 1 from public.flows f where f.id = flow_steps.flow_id)
  );

drop policy if exists "flow steps admin write" on public.flow_steps;
create policy "flow steps admin write" on public.flow_steps
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Progress: each student owns their row; staff can read (mentors get the
-- founder-preflight baseline answers as context).
drop policy if exists "flow progress own" on public.flow_progress;
create policy "flow progress own" on public.flow_progress
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "flow progress staff read" on public.flow_progress;
create policy "flow progress staff read" on public.flow_progress
  for select using (public.is_staff(auth.uid()));

-- Receipts: post as yourself once accepted/enrolled; read your own, your
-- cohort's, or everything as staff. Delete your own; admins moderate.
drop policy if exists "receipts insert own" on public.build_receipts;
create policy "receipts insert own" on public.build_receipts
  for insert with check (
    user_id = auth.uid()
    and (
      exists (select 1 from public.enrollments e where e.user_id = auth.uid())
      or exists (
        select 1 from public.applications a
        where a.user_id = auth.uid()
          and a.status in ('accepted', 'paid', 'enrolled')
      )
    )
  );

drop policy if exists "receipts read" on public.build_receipts;
create policy "receipts read" on public.build_receipts
  for select using (
    user_id = auth.uid()
    or public.is_staff(auth.uid())
    or (
      cohort_id is not null
      and (
        exists (
          select 1 from public.enrollments e
          where e.user_id = auth.uid()
            and e.cohort_id = build_receipts.cohort_id
        )
        or exists (
          select 1 from public.applications a
          where a.user_id = auth.uid()
            and a.status in ('accepted', 'paid', 'enrolled')
            and a.cohort_id = build_receipts.cohort_id
        )
      )
    )
  );

drop policy if exists "receipts delete own" on public.build_receipts;
create policy "receipts delete own" on public.build_receipts
  for delete using (user_id = auth.uid());

drop policy if exists "receipts admin delete" on public.build_receipts;
create policy "receipts admin delete" on public.build_receipts
  for delete using (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
