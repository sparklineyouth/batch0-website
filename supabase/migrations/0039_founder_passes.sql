-- ============================================================================
-- 0039 — Founder passes.
--
-- batch0 hands out 3D-printed business cards. Each card carries a short
-- random code and a serial number. Redeeming the code at /pass binds that
-- physical card to one account and unlocks perks: a review-queue fast-track,
-- a Discord role, a profile badge, and the ability to apply while the public
-- applications gate is closed.
--
-- Why this table looks the way it does — three constraints drive the shape:
--
--   1. The codes are PHYSICAL and cannot be rotated. The card in someone's
--      wallet is the only copy. If the code list leaks we cannot reissue
--      printed objects, so the plaintext code is NEVER stored here — only an
--      HMAC of it (see lib/founder-pass-code.ts). The HMAC pepper lives in
--      the environment (FOUNDER_PASS_PEPPER), NOT in this database, so a dump
--      of this table on its own is inert. Plain SHA-256 would not have been
--      enough: the codes are short (6-8 chars ~= 10^9 possibilities), which a
--      GPU exhausts against an unpeppered hash in seconds.
--
--   2. That same short code space is brute-forceable over the network, so
--      redemption is rate limited per account and per IP through the existing
--      rate_limit_check() RPC (0005) via lib/rate-limit.ts. That limiter is
--      load-bearing, not decorative — without it, ~100 guesses/sec finds a
--      live pass in days. No new limiter table is added here on purpose: the
--      0005 one is already atomic and serverless-safe.
--
--   3. A pass can be lost or handed to the wrong person, so passes are
--      revocable (revoked_at) rather than deleted — we want the audit trail.
--
-- There is deliberately NO user-facing insert/update policy. Redemption runs
-- through the service-role client in a server action (which bypasses RLS by
-- design); holders only ever SELECT their own row.
--
-- House-style notes: additive + idempotent DDL, text status columns rather
-- than pg enums, pgrst schema reload at the end.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- founder_passes: one row per printed card.
-- ----------------------------------------------------------------------------
create table if not exists public.founder_passes (
  id uuid primary key default gen_random_uuid(),

  -- The number embossed on the physical card ("#7"). Stable, human-facing,
  -- and safe to show: knowing a serial does not let you redeem anything.
  serial integer not null unique,

  -- HMAC-SHA256(normalized_code, FOUNDER_PASS_PEPPER), lowercase hex.
  -- Never the code itself. Unique so two cards can't collide onto one pass.
  code_hash text not null unique,

  -- Which print run this card came from. Lets us revoke a whole batch if a
  -- run is compromised, and tells us which cards predate a design change.
  batch text not null default 'cards-01',

  -- Set once, at redemption. ON DELETE SET NULL rather than CASCADE: if the
  -- account is deleted the physical card still exists, and we want the row to
  -- survive so the card can be re-redeemed or audited rather than silently
  -- vanishing from the batch.
  redeemed_by uuid references public.profiles(id) on delete set null,
  redeemed_at timestamptz,

  -- Revoked rather than deleted, so a lost/stolen card leaves a trail.
  revoked_at timestamptz,

  -- Admin freeform: who this card was physically handed to, where, when.
  note text,

  created_at timestamptz not null default now()
);

-- One pass per account. Partial, so the many unredeemed rows (redeemed_by
-- null) don't collide with each other — only real holders are constrained.
create unique index if not exists founder_passes_redeemed_by_key
  on public.founder_passes(redeemed_by)
  where redeemed_by is not null;

-- The redeem path looks a pass up by hash on every attempt.
create index if not exists founder_passes_code_hash_idx
  on public.founder_passes(code_hash);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.founder_passes enable row level security;

-- A holder can read their own pass (to render the serial on the dashboard).
-- Unredeemed rows match nobody, so the un-issued batch stays invisible.
drop policy if exists "founder_passes self select" on public.founder_passes;
create policy "founder_passes self select" on public.founder_passes
  for select using (redeemed_by = auth.uid());

drop policy if exists "founder_passes admin write" on public.founder_passes;
create policy "founder_passes admin write" on public.founder_passes
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- Settings
-- ----------------------------------------------------------------------------

-- Discord role granted to pass holders. Kept OUT of the discord_role_<role>_id
-- family on purpose: lib/discord.ts syncMemberRoles() treats every value in
-- roleIdByRole as batch0-managed and strips any role that isn't the member's
-- current target, which would tear this role off every holder on the next
-- sync (Stripe webhook, /sync, accept, resync-all). It is read as a sibling
-- field instead. See lib/discord.ts.
--
-- Seeded with the live role ID rather than '""' (which is what 0008/0033 did
-- for the other Discord IDs) so the perk works the moment this migration runs,
-- with no second manual step. It stays editable at /admin/discord — the form
-- upserts this same key, and `do nothing` below means re-running the migration
-- will never stomp a value changed there.
insert into public.site_settings (key, value)
values ('discord_role_founder_pass_id', '"1526965528638390482"'::jsonb)
on conflict (key) do nothing;

-- Whether a pass holder may apply while `applications_open` is false.
--
-- The global applications_open boolean conflates "not open to the public yet"
-- with "closed for good". Early access only makes sense in the first case, so
-- this is a separate switch the admin flips: on during the pre-launch window,
-- off once the cohort genuinely closes. Without it the pass would be a
-- permanent backdoor into a finished cohort.
--
-- Defaults to false: turning it on is an explicit act, so shipping this
-- migration changes nothing about who can apply today.
insert into public.site_settings (key, value)
values ('founder_pass_early_access', 'false')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
