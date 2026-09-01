-- ============================================================================
-- 0046 — Resources, flows, and receipts become enrolled-only.
--
-- Acceptance alone no longer opens anything: a student must pay tuition
-- (which creates their enrollments row) before they can read resources —
-- including pre-cohort ones — flows, or the receipts feed. This replaces
-- the accepted/paid/enrolled application-status branches added in 0042 and
-- 0044 with enrollment checks, matching the page gates in
-- app/dashboard/resources and app/dashboard/kickoff.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0045 applied.
-- ============================================================================

-- Read (replaces 0010): staff always; students must be enrolled — in the
-- resource's cohort, or in any cohort for global (cohort_id null) entries.
-- The old policy let ANY signed-in user read global rows.
drop policy if exists "resources read" on public.resources;
create policy "resources read" on public.resources
  for select using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.enrollments e
      where e.user_id = auth.uid()
        and (resources.cohort_id is null or e.cohort_id = resources.cohort_id)
    )
  );

-- The 0042 accepted-students policy is now redundant: enrolled students
-- read pre-cohort rows through "resources read" above, and accepted-but-
-- unpaid students get nothing.
drop policy if exists "resources pre-cohort read" on public.resources;

-- Flows (replaces 0044): drop the applications-status branch — published
-- flows are readable by enrolled students of the flow's cohort (or any
-- cohort for global flows) and staff. Steps need no change: "flow steps
-- read" defers to this policy via its RLS subquery.
drop policy if exists "flows read" on public.flows;
create policy "flows read" on public.flows
  for select using (
    public.is_staff(auth.uid())
    or (
      status = 'published'
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid()
          and (flows.cohort_id is null or e.cohort_id = flows.cohort_id)
      )
    )
  );

-- Receipts (replaces 0044): post and read as an enrolled student only.
drop policy if exists "receipts insert own" on public.build_receipts;
create policy "receipts insert own" on public.build_receipts
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.enrollments e where e.user_id = auth.uid()
    )
  );

drop policy if exists "receipts read" on public.build_receipts;
create policy "receipts read" on public.build_receipts
  for select using (
    user_id = auth.uid()
    or public.is_staff(auth.uid())
    or (
      cohort_id is not null
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid()
          and e.cohort_id = build_receipts.cohort_id
      )
    )
  );

notify pgrst, 'reload schema';
