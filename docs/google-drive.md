# Google Drive (team Drive tab)

In-app file storage is gone. Each team links one Google Drive folder and pins
Google links; batch0 stores ids, never files.

## What people see

- **Students** — `/dashboard/team?tab=drive`: link or replace the team folder
  (embedded in place, grid/list, "Open in Drive"), pin Docs/Sheets/Slides/
  Forms/Drive files (preview in place, Open, rename, unpin; 25 max).
  `/dashboard/files` redirects here.
- **Admins** (`teams.manage`) — same panel on `/admin/teams/[id]`, editable
  (to fix a wrong folder link); changes by non-members are audit-logged. The
  page also shows the team's Demo Day deck/video links, status and notes.
  Editable on purpose: the plan said read-only here, but it also lets
  `teams.manage` write through the same actions, and this page is the only
  place an admin can use that. Signed off at integration; mentors stay
  read-only. To make it read-only, pass `canEdit={false}` on the admin page.
- **Mentors** — same panel on `/mentor/teams/[id]`, read-only, plus the
  submitted deck/video.
- **Investors** — no team folder. Once a team submits, `/investor/teams/[id]`
  shows its deck and video links (`pitch_submissions.deck_url` / `video_url`)
  and notes; drafts stay private. An admin-set `teams.pitch_deck_url` /
  `pitch_video_url` fills in when there's no submitted link.

The team's own Demo Day tab keeps deck/video previews behind a Preview toggle
so the form stays short.

Embeds only render what the viewer's Google account can open. Folders and
files should be shared as "Anyone with the link" (the panel says so).

## How it works

- `lib/google-drive-links.ts` (pure, tested): parses every Google URL shape to
  `{kind, id, resourceKey, published, gid}` with an exact-hostname allow-list,
  and rebuilds open/preview URLs from those parts. A pasted URL is never used
  as an href or iframe src. Also `pitchPreview()` (Google/YouTube/Loom) and
  `safeHttpsUrl()`.
- `public.team_drive_links` (migration `0094_google_drive.sql`): select-only
  RLS (team members, `mentor.panel`, `teams.manage`); writes revoked from API
  roles and done by `app/dashboard/team/drive-link-actions.ts` (membership or
  `teams.manage`, rate-limited).
- Iframes are sandboxed (`allow-scripts allow-same-origin allow-popups
  allow-popups-to-escape-sandbox allow-forms allow-downloads
  allow-storage-access-by-user-activation`), `referrerpolicy=no-referrer`,
  no top navigation, no camera/mic.
- `next.config.js` sends `X-Frame-Options: SAMEORIGIN` and
  `Content-Security-Policy: frame-ancestors 'self'` (who may frame us; it does
  not limit what we embed). Don't add a restrictive `frame-src` without
  allowing drive/docs.google.com, Daily, YouTube and Loom.

## Older uploads

`student_files`, `team_drive_files` and the `student-files` / `team-drive`
buckets are frozen by 0094 (no API writes; reads kept). The Drive tab shows an
"Older uploads" list only when a student or their team still has rows, with
pitch decks/videos uploaded before links. Downloads go through
`/dashboard/team/older-uploads/[source]/[id]`, which checks ownership or
membership and the storage path prefix (`lib/legacy-upload-path.ts`) before
signing a 10-minute URL. Rows failing the prefix check aren't listed; any
other failure (object purged, signing error) comes back to the Drive tab with
"That file isn't available any more."

0094 also repairs old `pitch_submissions.video_url` values (http → https,
spaces encoded) and moves any it can't repair into `notes`, so the https
check is fully validated and no existing row is blocked from saving or
submitting.

Later cleanup (separate migration, after people have moved their files): drop
`file_feedback`, `team_drive_files`, `student_files` and
`pitch_submissions.deck_path/video_path`, empty and delete both buckets with
the Supabase CLI (as in 0013), then drop `team-drive` from `purgeTeamStorage`.

## Before the migration is applied

Code ships first. Without 0094 the Drive panel shows "Not set up yet", saving
a deck link says it isn't available yet (video and notes still save), and
everything else works.

## Future

Optional Google Picker (`drive.file` scope) behind
`NEXT_PUBLIC_GOOGLE_CLIENT_ID` + `NEXT_PUBLIC_GOOGLE_API_KEY`, writing the same
rows. Not built: pasting a link needs no Google credentials.
