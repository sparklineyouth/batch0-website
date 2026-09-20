-- ============================================================================
-- 0071 — An admin-settable "shown attendees" count for a webinar.
--
-- By default a webinar hides its turnout: a viewer must not be able to tell
-- whether they are one of three people or one of thirty (see canSeeRoster in
-- lib/live.ts — turnout is the host's business, and a visibly empty room
-- changes how students behave in one). This column is the deliberate exception:
-- when set, it is an *announced* headcount the room shows everyone ("43
-- watching") in place of the true, hidden roster. Null keeps the private
-- default — a viewer sees no count, a host sees the real one.
--
-- It's a display figure, nothing more: it gates no access and touches no token.
-- The value the room renders is re-sanitized by normalizeDisplayViewers on the
-- way out, so a number written straight into the row (rather than through the
-- admin form) still can't render a wall of digits into the header — but the
-- CHECK keeps the stored value honest at the source: non-negative, and capped
-- at the same 100000 the code accepts.
--
-- Nullable and additive: every existing event keeps working untouched, its
-- count simply null.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0070 are applied.
-- ============================================================================

alter table public.events
  add column if not exists display_viewer_count integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_display_viewer_count_check'
  ) then
    alter table public.events
      add constraint events_display_viewer_count_check
      check (
        display_viewer_count is null
        or (display_viewer_count >= 0 and display_viewer_count <= 100000)
      );
  end if;
end $$;

comment on column public.events.display_viewer_count is
  'Announced attendance shown in the live room in place of the hidden roster ("43 watching"). Null = private default (viewer sees no count, host sees the real one). Display only; gates nothing.';
