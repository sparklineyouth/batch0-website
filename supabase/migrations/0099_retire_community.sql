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
--   5. Lesson copy that points at Discussions, office hours or the check-in
--      is rewritten to Discord, Support and 1:1 calls.
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

-- 5. Lesson copy that still sends students to retired features (the Week 1
--    field guide, 0073): peer discussion goes to Discord (/dashboard/community),
--    a private question to Support, office hours to 1:1 calls (0097), and the
--    check-in wording 0093 didn't reach (lessons that never linked
--    /dashboard/checkin) becomes the weekly update. Exact sentences first;
--    then any other link to a retired page is repointed, so a lesson an admin
--    has edited still lands somewhere real. No replacement contains a phrase
--    replaced after it, so a re-run changes nothing.

do $$
declare
  r record;
begin
  if to_regclass('public.lessons') is null then return; end if;
  for r in
    select * from (values
      (1, $t$Paste the message you're sending into a thread in [Discussions](/dashboard/discussions) and ask the cohort and the team to tear it apart. If you'd rather not post it publicly, send it to the team privately and we'll reply in the thread.$t$,
           $t$Paste the message you're sending into your cohort channel on [Discord](/dashboard/community) and ask the cohort to tear it apart. If you'd rather not post it publicly, send it to the team privately through [Support](/dashboard/support/new?topic=program) and we'll reply there.$t$),
      (2, $t$- [Office hours](/dashboard/office-hours): book an open slot with a mentor when you want a second brain on something specific.$t$,
           $t$- [1:1 calls](/dashboard/calls): ask the team for a call when you want a second brain on something specific.$t$),
      (3, $t$Ask the batch0 team privately in [Discussions](/dashboard/discussions/new?to=team); only you and the team see it, and we reply in the thread.$t$,
           $t$Ask the batch0 team privately through [Support](/dashboard/support/new?topic=program); only you and the team see it, and we reply there.$t$),
      (4, $t$Use the cohort in Discussions as your debrief partner;$t$,
           $t$Use the cohort on Discord as your debrief partner;$t$),
      (5, $t$- [Discussions](/dashboard/discussions): threads with your cohort, and a private line to the batch0 team.$t$,
           $t$- [Discord](/dashboard/community): chat with your cohort. [Support](/dashboard/support/new?topic=program) is your private line to the batch0 team.$t$),
      (6, $t$Interviews 1 to 4. Office hours if something is off.$t$,
           $t$Interviews 1 to 4. Ask for a 1:1 call if something is off.$t$),
      (7, $t$This is the most common thing founders bring to [office hours](/dashboard/office-hours) in Week 1, and it's a good use of a slot. Book an open one, bring your one-page summary and your three strongest quotes, and let the mentor read them cold. If no slot is open, post the summary privately to the team in [Discussions](/dashboard/discussions/new?to=team) and we'll give you a read in the thread.$t$,
           $t$This is the most common thing founders bring to a [1:1 call](/dashboard/calls) in Week 1, and it's a good use of one. Ask for a call, bring your one-page summary and your three strongest quotes, and let the mentor read them cold. If you can't wait for a call, send the summary privately to the team through [Support](/dashboard/support/new?topic=program) and we'll give you a read there.$t$),
      (8, $t$Paste your top three statements into a thread in [Discussions](/dashboard/discussions) with your scores.$t$,
           $t$Paste your top three statements into your cohort channel on [Discord](/dashboard/community) with your scores.$t$),
      (9, $t$The tell: a blank blockers box, and a Discussions page you've never opened. The fix: the twenty-minute rule. Stuck for twenty minutes means post it, privately to the team or openly to the cohort. Book an office-hours slot when one is open. The team reads every check-in and every private thread; nothing you're stuck on is too small or too early.$t$,
           $t$The tell: a blank blockers line, and a cohort channel you've never posted in. The fix: the twenty-minute rule. Stuck for twenty minutes means post it, privately to the team through [Support](/dashboard/support/new?topic=program) or openly to the cohort on [Discord](/dashboard/community). Ask for a [1:1 call](/dashboard/calls) when you need one. The team reads every weekly update and every private question; nothing you're stuck on is too small or too early.$t$),
      (10, $t$If any fix needs a second opinion, post it in [Discussions](/dashboard/discussions) today rather than after the check-in.$t$,
           $t$If any fix needs a second opinion, post it on [Discord](/dashboard/community) today rather than after the weekly update.$t$),
      (11, $t$Post a photo or a link to your canvas privately to the team in [Discussions](/dashboard/discussions/new?to=team), or bring it to an open [office hours](/dashboard/office-hours) slot.$t$,
           $t$Send a photo or a link to your canvas privately to the team through [Support](/dashboard/support/new?topic=program), or bring it to a [1:1 call](/dashboard/calls).$t$),
      (12, $t$Post it privately to the team in [Discussions](/dashboard/discussions/new?to=team) and we'll pick it up in the thread. The weekly update is the weekly record; Discussions is the fast lane.$t$,
           $t$Send it privately to the team through [Support](/dashboard/support/new?topic=program) and we'll pick it up there. The weekly update is the weekly record; Support is the fast lane.$t$),
      (13, $t$Every check-in gets read. Every private thread gets a reply.$t$,
           $t$Every weekly update gets read. Every private question gets a reply.$t$),
      (14, $t$tell us directly in [Discussions](/dashboard/discussions/new?to=team) or at hello@batch0.org.$t$,
           $t$tell us directly through [Support](/dashboard/support/new?topic=program) or at hello@batch0.org.$t$),
      (15, $t$Swap signal summaries with another team in [Discussions](/dashboard/discussions).$t$,
           $t$Swap signal summaries with another team on [Discord](/dashboard/community).$t$),
      (16, $t$| Weekly check-in |$t$,
           $t$| Weekly update |$t$),
      (17, $t$Post it privately to the team in [Discussions](/dashboard/discussions/new?to=team) with the problem statement$t$,
           $t$Send it privately to the team through [Support](/dashboard/support/new?topic=program) with the problem statement$t$),
      (18, $t$[Discussions](/dashboard/discussions/new?to=team)$t$,
           $t$[Support](/dashboard/support/new?topic=program)$t$),
      (19, $t$/dashboard/discussions/new?to=team$t$,
           $t$/dashboard/support/new?topic=program$t$),
      (20, $t$[Discussions](/dashboard/discussions)$t$,
           $t$[Discord](/dashboard/community)$t$),
      (21, $t$/dashboard/discussions$t$,
           $t$/dashboard/community$t$),
      (22, $t$[Office hours](/dashboard/office-hours)$t$,
           $t$[1:1 calls](/dashboard/calls)$t$),
      (23, $t$/dashboard/office-hours$t$,
           $t$/dashboard/calls$t$)
    ) as v(ord, old_text, new_text)
    order by ord
  loop
    update public.lessons
    set description = replace(description, r.old_text, r.new_text)
    where strpos(description, r.old_text) > 0;
  end loop;
end $$;

notify pgrst, 'reload schema';
