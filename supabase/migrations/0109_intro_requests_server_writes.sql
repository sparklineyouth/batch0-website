-- ============================================================================
-- 0109 — investor intro requests: clients read, only the server writes, and
-- the team's notes stay with the team.
--
-- createIntroRequest (app/investor/teams/[id]/actions.ts) caps an investor at
-- five requests waiting on the batch0 team, and never puts a request the team
-- already acted on back to `requested` (lib/intro-requests.ts). It writes
-- with the service role — every write to this table does, including the
-- admin status changes in app/admin/intros/actions.ts, which also audit-log
-- them. But 0011's policies still let an investor's own JWT write the table
-- over PostgREST: INSERT any number of requests (past the cap), and UPDATE
-- their own rows with no column limit — status back to `requested`, or
-- straight to `committed` / `wired`, and `admin_notes`. This drops both write
-- policies and the table write privileges for the API roles, like 0097 did
-- for the call tables.
--
-- Reads stay as they are (the investor's own rows, admins, and — 0019 — the
-- members of the team), with one column held back: `admin_notes` is what the
-- batch0 team writes about an intro, and RLS is row-level, so every reader of
-- a row could read it. The app never shows it outside /admin/intros, which
-- reads with the service role. The table-wide select comes off first and the
-- other columns are granted back by name — a column revoke against a
-- table-level grant is a no-op (0084 explains). A column added later is not
-- readable by the API roles until a migration grants it.
--
-- No app code depends on this: every read and write already goes through the
-- service role. Idempotent; safe to re-run. Changes no rows. Assumes 0011.
-- ============================================================================

do $$
begin
  if to_regclass('public.intro_requests') is null then
    return;
  end if;

  execute 'drop policy if exists "intro_requests investor write" on public.intro_requests';
  execute 'drop policy if exists "intro_requests update" on public.intro_requests';

  execute 'revoke all on public.intro_requests from anon, authenticated';
  execute 'grant select (id, investor_id, team_id, status, message, created_at, updated_at)
             on public.intro_requests to authenticated';

  execute $c$comment on table public.intro_requests is
    'Investor → team intro requests. Read by the investor, the team and admins (admin_notes excepted); written only by service-role server actions.'$c$;
end $$;
