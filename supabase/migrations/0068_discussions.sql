-- ============================================================================
-- 0068 — Discussions: cohort threads + private questions to the team.
--
-- Two things that look alike and must not be confused, in one table so a
-- thread page, a reply, and a notification are the same code either way:
--
--   visibility = 'cohort'  A discussion. Visible to every enrolled student in
--                          the cohort it was posted to, plus the team. Anyone
--                          who can see it can reply. This is the "talk to
--                          other people" surface.
--
--   visibility = 'admin'   A private question to the batch0 team. Visible to
--                          exactly two parties: the student who asked it, and
--                          people holding `discussions.manage` (admins, via
--                          the '*' wildcard). No other student can see that
--                          it exists. The team replies in the thread.
--
-- The RLS below is the hard line for that privacy; the server actions and
-- the lib/discussions.ts reads filter on the same predicate explicitly, so
-- the policy is the backstop rather than the only thing holding it.
--
-- Also mints the `discussions.manage` permission (lib/permissions.ts). Not
-- granted to any built-in role here: `admin` already holds '*', and the
-- point of a private question is that only the admin team reads it. A
-- custom role can be given it at /admin/roles without a deploy.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0067 are applied.
-- ============================================================================

create table if not exists public.discussion_threads (
  id uuid primary key default gen_random_uuid(),
  -- The cohort the author was in when they posted. Always set for a cohort
  -- discussion (it IS the audience). Context only for a private question,
  -- so the team knows which batch is asking. Nullable and `set null` so a
  -- deleted cohort leaves the thread readable to its author and the team
  -- rather than blocking the delete.
  cohort_id uuid references public.cohorts(id) on delete set null,
  author_id uuid not null references public.profiles(id) on delete cascade,
  visibility text not null check (visibility in ('cohort', 'admin')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 8000),
  -- 'closed' means no more replies: a resolved question, or a discussion
  -- the team locked. The UI labels it by visibility; the rule is the same.
  status text not null default 'open' check (status in ('open', 'closed')),
  -- Snapshot of "was this the team speaking" at post time — see the same
  -- column on discussion_replies below.
  is_staff boolean not null default false,
  -- Cohort discussions only: the team can pin one to the top of the board.
  pinned boolean not null default false,
  -- Private questions only: true while the ball is in the team's court —
  -- set on every student message, cleared on every team reply. The admin
  -- queue is `where visibility = 'admin' and needs_reply` and nothing else,
  -- which is why it's a column and not something derived at read time.
  needs_reply boolean not null default false,
  -- Denormalised for the list views; maintained by the trigger below.
  reply_count int not null default 0,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The cohort board: pinned first, then most recent activity.
create index if not exists discussion_threads_cohort_board_idx
  on public.discussion_threads (cohort_id, pinned desc, last_activity_at desc)
  where visibility = 'cohort';
-- A student's own questions.
create index if not exists discussion_threads_author_idx
  on public.discussion_threads (author_id, last_activity_at desc);
-- The team's queue: private questions still waiting on a reply.
create index if not exists discussion_threads_needs_reply_idx
  on public.discussion_threads (last_activity_at desc)
  where visibility = 'admin' and needs_reply;

drop trigger if exists touch_discussion_threads on public.discussion_threads;
create trigger touch_discussion_threads before update on public.discussion_threads
  for each row execute procedure public.touch_updated_at();

create table if not exists public.discussion_replies (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.discussion_threads(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 8000),
  -- Snapshot of "was this the team speaking" at post time, so the badge on a
  -- reply doesn't flip if the author's role changes later. Mirrors
  -- team_messages.kind (0011).
  is_staff boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists discussion_replies_thread_idx
  on public.discussion_replies (thread_id, created_at);

-- reply_count and last_activity_at on the thread are maintained here rather
-- than by the server action, so two replies landing at once can't lose an
-- increment to a read-then-write race. A delete recounts; it does not roll
-- last_activity_at back, since the thread did just change.
create or replace function public.discussion_replies_touch_thread()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  tid uuid := coalesce(new.thread_id, old.thread_id);
begin
  update public.discussion_threads t
  set reply_count = (
        select count(*) from public.discussion_replies r where r.thread_id = tid
      ),
      last_activity_at = now()
  where t.id = tid;
  return null;
end;
$$;

drop trigger if exists discussion_replies_touch_thread on public.discussion_replies;
create trigger discussion_replies_touch_thread
  after insert or delete on public.discussion_replies
  for each row execute procedure public.discussion_replies_touch_thread();

alter table public.discussion_threads enable row level security;
alter table public.discussion_replies enable row level security;

-- ----------------------------------------------------------------------------
-- Who may read a thread. One function, used by both tables' policies, so the
-- rule for a reply can never drift from the rule for its thread.
--
--   * the team (admins, or anyone holding discussions.manage)
--   * the author — this is what makes a private question readable to the
--     one student who asked it
--   * for a cohort discussion, anyone enrolled in that cohort
--
-- A private question deliberately has no cohort clause: enrolment in the
-- same cohort grants nothing.
-- ----------------------------------------------------------------------------
create or replace function public.can_read_discussion(t public.discussion_threads, uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    public.is_admin(uid)
    or public.has_permission(uid, 'discussions.manage')
    or t.author_id = uid
    or (
      t.visibility = 'cohort'
      and t.cohort_id is not null
      and exists (
        select 1 from public.enrollments e
        where e.user_id = uid and e.cohort_id = t.cohort_id
      )
    );
$$;

drop policy if exists "discussion_threads read" on public.discussion_threads;
create policy "discussion_threads read" on public.discussion_threads
  for select using (public.can_read_discussion(discussion_threads, auth.uid()));

-- A student posts as themselves, and a cohort discussion has to go to a
-- cohort they're actually in. A private question carries no such check —
-- any signed-in student may ask the team something.
drop policy if exists "discussion_threads insert" on public.discussion_threads;
create policy "discussion_threads insert" on public.discussion_threads
  for insert with check (
    author_id = auth.uid()
    and (
      visibility = 'admin'
      or (
        cohort_id is not null
        and exists (
          select 1 from public.enrollments e
          where e.user_id = auth.uid() and e.cohort_id = discussion_threads.cohort_id
        )
      )
    )
  );

-- The outer boundary: the team, and the author. Which columns each may
-- touch (only the team pins or locks; an author may resolve their own
-- question) is enforced in the server actions, which RLS can't express.
drop policy if exists "discussion_threads update" on public.discussion_threads;
create policy "discussion_threads update" on public.discussion_threads
  for update using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'discussions.manage')
    or author_id = auth.uid()
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'discussions.manage')
    or author_id = auth.uid()
  );

drop policy if exists "discussion_threads delete" on public.discussion_threads;
create policy "discussion_threads delete" on public.discussion_threads
  for delete using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'discussions.manage')
    or author_id = auth.uid()
  );

-- Replies inherit the thread's readability, exactly.
drop policy if exists "discussion_replies read" on public.discussion_replies;
create policy "discussion_replies read" on public.discussion_replies
  for select using (
    exists (
      select 1 from public.discussion_threads t
      where t.id = discussion_replies.thread_id
        and public.can_read_discussion(t, auth.uid())
    )
  );

-- You may reply to what you can read, while it's open.
drop policy if exists "discussion_replies insert" on public.discussion_replies;
create policy "discussion_replies insert" on public.discussion_replies
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.discussion_threads t
      where t.id = discussion_replies.thread_id
        and t.status = 'open'
        and public.can_read_discussion(t, auth.uid())
    )
  );

drop policy if exists "discussion_replies delete" on public.discussion_replies;
create policy "discussion_replies delete" on public.discussion_replies
  for delete using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'discussions.manage')
    or author_id = auth.uid()
  );

comment on table public.discussion_threads is
  'Cohort discussion threads (visibility=cohort, readable by the cohort) and private questions to the team (visibility=admin, readable only by the author and discussions.manage holders).';
comment on table public.discussion_replies is
  'Replies on discussion_threads. Readability is inherited from the thread via can_read_discussion().';

notify pgrst, 'reload schema';
