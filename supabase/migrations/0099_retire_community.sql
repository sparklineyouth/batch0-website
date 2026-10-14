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
--   4. What the two retired staff queues still held moves to Support
--      (/admin/support), so nothing open is dropped:
--        * a private question still waiting on the team (the old
--          /admin/discussions queue: visibility = 'admin' and needs_reply)
--          becomes a `program` ticket from its author, with the thread so far
--          as the body;
--        * an open DM report (the old /admin/messages queue) becomes a
--          sensitive `concern` ticket from its reporter, with the
--          conversation as a staff-only note — what /admin/messages showed,
--          unsent messages included.
--      No email goes out; the team replies from the ticket as usual. Each
--      ticket records its source in context.carriedFrom, so a re-run adds
--      nothing. The source rows are not changed.
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

-- 4. Carry open items into Support. Reference and token follow
--    lib/support-access.ts (B0-XXXX-XXXX over its 30-symbol alphabet; 43
--    base64url chars, here from two random UUIDs = 244 random bits).
do $$
declare
  c record;
  new_ticket_id uuid;
  ref text;
  tries int;
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
begin
  if to_regclass('public.support_tickets') is null
     or to_regclass('public.support_ticket_replies') is null
     or to_regclass('public.profiles') is null then
    return;
  end if;

  create temp table if not exists retired_queue_items (
    carried_from text primary key,
    user_id uuid,
    requester_email text not null,
    requester_name text,
    category text not null,
    priority text not null,
    sensitive boolean not null,
    source text not null,
    subject text not null,
    body text not null,
    staff_note text,
    received_at timestamptz not null,
    activity_at timestamptz not null
  ) on commit drop;
  truncate retired_queue_items;

  if to_regclass('public.discussion_threads') is not null
     and to_regclass('public.discussion_replies') is not null then
    insert into retired_queue_items
    select
      'discussion:' || t.id,
      t.author_id,
      lower(p.email),
      nullif(left(p.full_name, 120), ''),
      'program', 'normal', false, 'discussions',
      t.title,
      left(
        'Moved from Discussions. Asked ' || to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD') || '.'
        || E'\n\n' || t.body
        || coalesce(E'\n\n' || (
          select string_agg(
            case when r.is_staff then 'Team' else 'Student' end
              || ' (' || to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD') || '): ' || r.body,
            E'\n\n' order by r.created_at, r.id)
          from public.discussion_replies r
          where r.thread_id = t.id), ''),
        8000),
      null,
      t.created_at,
      t.last_activity_at
    from public.discussion_threads t
    join public.profiles p on p.id = t.author_id
    where t.visibility = 'admin' and t.needs_reply;
  end if;

  if to_regclass('public.dm_reports') is not null
     and to_regclass('public.dm_messages') is not null then
    insert into retired_queue_items
    select
      'dm_report:' || d.id,
      p.id,
      -- A reporter whose account is gone: replies go to the team inbox.
      coalesce(lower(p.email), 'hello@batch0.org'),
      case when p.id is null then 'Deleted account' else nullif(left(p.full_name, 120), '') end,
      'concern', 'urgent', true, 'dm_report',
      'Reported direct message',
      left(
        'Report about a direct message conversation, filed '
          || to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD') || '.'
          || E'\n\nReason: ' || d.reason,
        8000),
      'Reported conversation ' || d.conversation_id || '. Staff only.' || E'\n\n'
        || case
          when tr.lines is null then 'No messages.'
          when char_length(tr.lines) > 7800 then '…' || right(tr.lines, 7799)
          else tr.lines
        end,
      d.created_at,
      d.created_at
    from public.dm_reports d
    left join public.profiles p on p.id = d.reporter_id
    left join lateral (
      select string_agg(
        '[' || to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC] '
          || coalesce(nullif(s.full_name, ''), s.email, 'Deleted account')
          || case when m.unsent_at is not null then ' (unsent)' else '' end
          || ': ' || m.body,
        E'\n' order by m.created_at, m.id) as lines
      from public.dm_messages m
      left join public.profiles s on s.id = m.sender_id
      where m.conversation_id = d.conversation_id
    ) tr on true
    where d.status = 'open';
  end if;

  for c in
    select i.* from retired_queue_items i
    where not exists (
      select 1 from public.support_tickets s
      where s.context ->> 'carriedFrom' = i.carried_from)
    order by i.received_at
  loop
    tries := 0;
    loop
      ref := 'B0-'
        || (select string_agg(substr(alphabet, 1 + floor(random() * 30)::int, 1), '') from generate_series(1, 4))
        || '-'
        || (select string_agg(substr(alphabet, 1 + floor(random() * 30)::int, 1), '') from generate_series(1, 4));
      begin
        insert into public.support_tickets (
          reference, token, user_id, requester_email, requester_name,
          category, subject, body, priority, sensitive, channel, context,
          received_at, requester_activity_at, last_activity_at)
        values (
          ref,
          translate(rtrim(encode(decode(
            replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
            'hex'), 'base64'), '='), '+/', '-_'),
          c.user_id, c.requester_email, c.requester_name,
          c.category, c.subject, c.body, c.priority, c.sensitive, 'other',
          jsonb_build_object('source', c.source, 'carriedFrom', c.carried_from),
          c.received_at, c.activity_at, c.activity_at)
        returning id into new_ticket_id;
        exit;
      exception when unique_violation then
        tries := tries + 1;
        if tries >= 5 then raise; end if;
      end;
    end loop;

    -- An internal system note moves no clock and is never shown to the
    -- requester (support_ticket_replies_touch_ticket, lib/support.ts).
    if c.staff_note is not null then
      insert into public.support_ticket_replies (ticket_id, body, is_staff, is_internal, via)
      values (new_ticket_id, c.staff_note, true, true, 'system');
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
