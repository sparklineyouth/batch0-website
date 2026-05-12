-- ============================================================================
-- 0015 — AI usage tracking + overage billing.
--
-- Each AI chat completion is logged with token counts; aggregated into
-- ai_usage by month so the chat handler can enforce the free quota and
-- create overage charges via user_charges.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0014 applied.
-- ============================================================================

-- Per-message token counts. Anthropic returns usage on every response.
alter table public.ai_messages
  add column if not exists input_tokens int,
  add column if not exists output_tokens int,
  add column if not exists cache_creation_tokens int,
  add column if not exists cache_read_tokens int;

-- Per-conversation team association so the chat handler can scope
-- retrieval + context to a specific team. Optional — solo students
-- (no team yet) leave this null.
alter table public.ai_conversations
  add column if not exists team_id uuid references public.teams(id)
    on delete set null;

create index if not exists ai_conversations_team_idx
  on public.ai_conversations (team_id, updated_at desc);

-- Monthly usage rollup. One row per (user, month). The chat handler
-- writes here on every request and the dashboard reads from it to show
-- "you've used X of Y free tokens."
create table if not exists public.ai_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- First day of the calendar month (UTC) the usage falls in.
  month_start date not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_creation_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  -- Overage cents already billed this month (so re-runs don't double bill).
  billed_cents int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month_start)
);

create index if not exists ai_usage_month_idx
  on public.ai_usage (month_start, user_id);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage self read" on public.ai_usage;
create policy "ai_usage self read" on public.ai_usage
  for select using (
    user_id = auth.uid() or public.is_admin(auth.uid())
  );

-- Writes are service-role only (chat handler bumps counters with the
-- admin client). No client INSERT/UPDATE policy on purpose.

notify pgrst, 'reload schema';
