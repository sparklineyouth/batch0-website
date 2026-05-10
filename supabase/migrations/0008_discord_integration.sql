-- ============================================================================
-- 0008 — Discord integration: per-user link, configurable channel + role IDs.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0007 applied.
-- ============================================================================

-- profile.discord_*: stored once we've completed an OAuth link.
alter table public.profiles
  add column if not exists discord_user_id text,
  add column if not exists discord_username text,
  add column if not exists discord_avatar text,
  add column if not exists discord_linked_at timestamptz;

create unique index if not exists profiles_discord_user_id_unique
  on public.profiles (discord_user_id)
  where discord_user_id is not null;

-- New site_settings keys for channel and role IDs. We keep them as
-- JSON strings so the existing settings API "just works."
insert into public.site_settings (key, value) values
  ('discord_channel_announcements_id', '""'),
  ('discord_channel_events_id', '""'),
  ('discord_channel_admin_feed_id', '""'),
  ('discord_role_student_id', '""'),
  ('discord_role_mentor_id', '""'),
  ('discord_role_admin_id', '""'),
  ('discord_role_investor_id', '""')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
