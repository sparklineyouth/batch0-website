-- ============================================================================
-- 0091 — Notification importance: per-person classification of notification
-- types into "important" and everything else.
--
-- /notifications now has two tabs. Which tab a notification lands in is a
-- function of its `type`, and every type has a sensible default baked into
-- lib/notification-importance.ts (acceptance decisions, failed payments and
-- DMs are important; receipts, recaps and staff queue chatter are not).
--
-- This table holds only the OVERRIDES — the rows where a person disagreed
-- with the default. Three consequences, all deliberate:
--
--   * A new notification type ships with its default classification for
--     everyone, with no backfill and no rows to write.
--   * Setting a type back to its default DELETES the row rather than storing
--     the default again, so "reset to defaults" is a plain delete and the
--     table stays roughly the size of people's actual disagreements.
--   * The defaults live in TypeScript, not in a check constraint or a seeded
--     table, because the UI, the classifier and the migration would otherwise
--     all need to agree on a list that changes every time a feature adds a
--     notification.
--
-- `type` is intentionally un-constrained text, matching
-- public.notifications.type: a notification type is a string a feature picks,
-- not an enum the database polices. An override for a type that no longer
-- exists is inert.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0090 are applied.
-- ============================================================================

create table if not exists public.notification_importance (
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  importance text not null check (importance in ('important', 'other')),
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

-- The only read this table ever gets is "all of my overrides", which the
-- primary key already serves (user_id is its leading column).

alter table public.notification_importance enable row level security;

-- Self-service only, every verb. Unlike public.notifications there is no
-- admin read path: how someone sorts their own inbox is nobody else's
-- business, and no admin screen needs it.
drop policy if exists "notification_importance self select"
  on public.notification_importance;
create policy "notification_importance self select"
  on public.notification_importance
  for select using (user_id = auth.uid());

drop policy if exists "notification_importance self insert"
  on public.notification_importance;
create policy "notification_importance self insert"
  on public.notification_importance
  for insert with check (user_id = auth.uid());

drop policy if exists "notification_importance self update"
  on public.notification_importance;
create policy "notification_importance self update"
  on public.notification_importance
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "notification_importance self delete"
  on public.notification_importance;
create policy "notification_importance self delete"
  on public.notification_importance
  for delete using (user_id = auth.uid());

notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- One-off: retire the "<name> needs a mentor" backlog.
--
-- The at-risk cron used to fan that title out to EVERY admin, once per
-- unassigned student per week, which is the pile-up that prompted all of this.
-- The cron no longer sends it (app/api/cron/at-risk-intervene/route.ts — the
-- at_risk_interventions row and /admin/interventions carry the signal now),
-- but the rows it already wrote are still sitting unread in admin inboxes.
--
-- They're marked read rather than deleted: nothing is lost, the badge clears,
-- and anyone who wants the history still has it. Scoped by type AND title so
-- it cannot touch the mentor-facing "needs a nudge" notifications, which are
-- the same type and are still wanted.
-- ----------------------------------------------------------------------------
update public.notifications
set read_at = now()
where type = 'intervention'
  and title like '% needs a mentor'
  and read_at is null;
