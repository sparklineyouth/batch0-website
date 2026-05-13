-- Grant team members read access to intro_requests for their own team.
-- Previously only admins and the requesting investor could read; the
-- student-facing /dashboard/intros page needs the team to see them too.

drop policy if exists "intro_requests team member read"
  on public.intro_requests;
create policy "intro_requests team member read"
  on public.intro_requests
  for select using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = intro_requests.team_id
        and tm.user_id = auth.uid()
    )
  );
