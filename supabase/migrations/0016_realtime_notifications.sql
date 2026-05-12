-- ============================================================================
-- 0016 — Enable Realtime on public.notifications.
--
-- The notification bell subscribes to Supabase Realtime so the bell
-- count + dropdown update without a page reload. Falls back to a 60s
-- poll if the publication isn't configured, but UX is noticeably worse
-- without realtime.
--
-- Idempotent: only adds the table to supabase_realtime if it isn't
-- already a member.
-- ============================================================================

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end$$;

notify pgrst, 'reload schema';
