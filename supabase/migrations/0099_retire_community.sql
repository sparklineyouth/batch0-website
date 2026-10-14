-- 0099 — Retire the in-app community features that duplicated Discord.
--
-- Discussions (0068), the team thread (0011), announcement reactions (0027),
-- lesson comments (0005) and direct messages (0089) no longer have any UI.
-- Their tables, rows, read policies, functions and triggers all stay, so this
-- is reversible by re-running the original migration. What goes:
--
--   1. Every client WRITE policy (insert / update / delete) on
--      discussion_threads, discussion_replies, team_messages,
--      announcement_reactions and lesson_comments. With RLS on and no write
--      policy, the public anon key can no longer write to tables nobody reads.
--      Names at the time of writing: "discussion_threads insert|update|delete",
--      "discussion_replies insert|delete", "team_messages write",
--      "announcement_reactions self insert|self delete",
--      "lesson_comments self insert|self update|self delete".
--      (DM tables never had client write policies.)
--   2. The discussions.manage permission, from every role that holds it.
--   3. dm_messages from the supabase_realtime publication.
--
-- Idempotent, and safe on a database that never had one of these tables.

do $$
declare
  p record;
begin
  for p in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'discussion_threads',
        'discussion_replies',
        'team_messages',
        'announcement_reactions',
        'lesson_comments'
      )
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

update public.app_roles
set permissions = array_remove(permissions, 'discussions.manage')
where permissions @> array['discussions.manage']::text[];

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime drop table public.dm_messages;
  end if;
end $$;

notify pgrst, 'reload schema';
