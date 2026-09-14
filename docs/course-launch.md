# Fall 2026 course launch

The course package covers September 14–November 13, 2026: kickoff plus four two-week sprints, Validate / Build / Market / Pitch. The authoritative source lives in `content/course-launch/`.

This GitHub repository is public. Course source, instructor materials, generated PDFs, and import manifests stay in the ignored local `content/course-launch/` directory and private Supabase storage. Do not commit them or include them in the public website bundle. Keep a private backup of that directory for future authoring; the live database and private storage hold the published student version.

## Included

- 9 weekly modules and 37 complete original lessons, each with an objective, guided exercise, self-check, deliverable, and completion condition.
- 9 printable PDF workbooks containing the full week's readings, original worksheets, and optional source links; editable Markdown sources accompany each workbook.
- 9 CSV templates for interviews, experiment results, build tasks, usability, unit economics, outreach, funnels, pitch claims, and next-month commitments.
- 18 checked primary-source articles/documentation pages, all optional. No external course purchase is required.
- A nine-week syllabus and facilitator guide, including a 60-minute kickoff agenda compatible with the current private broadcast/Q&A room.

The generated import includes 9 module rows, 37 lesson rows, 36 resource rows, and 45 private storage objects (27 distinct uploaded files). Lesson text is approximately 13,079 original words. Existing global resources remain untouched.

## Authoring and rebuild

Edit `curriculum.mjs`, `workbooks.mjs`, or `sources.mjs` in the course-launch directory, then run:

```sh
node content/course-launch/build-manifest.mjs
node --test content/course-launch/validate.test.mjs
```

The builder uses the repository's Markdown tools and Playwright with the installed Chrome channel to export the original HTML into PDFs. It reuses a PDF when its HTML source digest is unchanged, so a routine rebuild preserves binary hashes. `generated/pdf-source-hashes.json` tracks this. HTML files remain editable local sources; they are not uploaded because Supabase intentionally serves HTML as plain text. The PDF is the student-facing printable attachment.

The tests validate actual MCP row schemas, cohort/date coverage, preserved Week 1 IDs, lesson completion structure, storage references, local file digests, upload envelopes, and source uniqueness. After changing layout, render the new PDFs and inspect pages in addition to running tests.

## Import contract

`content/course-launch/manifest.json` contains `cohort`, `modules`, `lessons`, `resources`, and `assets`. Module, lesson, and resource rows use the actual database fields. Asset records contain bucket, path, local path, content type, byte count, and SHA-256 digest.

1. Read current records through the Batch0 MCP and save a private backup.
2. Compare current authored content with the intended change. Existing rows require their current MCP hash; do not overwrite newer author edits blindly.
3. Dry-run every asset and content batch. New modules must precede their lessons.
4. Upload original assets to private `course-materials` and `resources` under `course-launch/fall-2026/`. PDF uploads use `pdf_base64`; Markdown and CSV use `text`.
5. Upsert modules, then lessons, then resources by stable ID. Do not delete unrelated records or import assignments/challenges as course work: the former assignment tables were removed, and public challenges are a different feature.
6. Read back every imported row, verify counts and field values, and verify stored bytes match asset digests. Check an enrolled student's course page and signed PDF download.

Importing the manifest is an explicit operation. Running the builder or content tests never writes to the database or storage.

The reusable importer uses the real MCP stdio protocol, previews every operation, saves private before-images under `out/course-launch-import/`, journals successful non-overwriting uploads, and verifies every saved content field:

```sh
node mcp/import-curriculum.mjs          # preview only
node mcp/import-curriculum.mjs --apply  # apply the reviewed package
```

Use a new versioned asset path when changing a published file. The MCP never overwrites an existing private object.

## Approved session provisioning

The approved Fall schedule is published: kickoff, eight subsequent Monday workshops, nine Thursday office hours, and the Friday Demo Day. The private `approved-schedule.md` and `approved-schedule.ics` exports reflect all 19 database records. Students use Events and its individual calendar downloads.

`scripts/prepare-course-schedule.mts` previews by default. Applying requires both `--approved` and `--demo-format=staff-showcase`, plus the private approved proposal and existing environment configuration. It validates dates against the cohort and modules, handles Eastern daylight-saving time, refuses conflicting identities, creates private expiring rooms, writes before-images and receipts, and verifies the saved records. It sends no messages. A repeat run against the published schedule created zero rooms and changed zero events.

```sh
node scripts/prepare-course-schedule.mts --self-test
node --env-file=.env.local scripts/prepare-course-schedule.mts
node --env-file=.env.local scripts/prepare-course-schedule.mts --apply --approved --demo-format=staff-showcase
```

The original Week 1 module ID is `8f59cc82-e318-4165-90a0-5901b3d1c036`; its five lesson IDs are preserved to retain student progress and comments. A fresh MCP read on September 14 confirmed those lessons had no existing video URLs, video paths, or materials. The package intentionally has no fabricated video metadata: these are complete reading/workshop lessons. The main app must render Markdown descriptions and offer completion without an empty “video not uploaded” panel.

## Instructional boundaries

Curriculum dates are weekly work windows, not booked live appointments or graded submission deadlines. Students use Course, Resources, Files/team workspace, and Check-in. The Events page remains authoritative for actual session instructions.

All worked customer examples and numerical examples are labeled hypothetical. Metrics in student projects must distinguish observed, estimated, and planned. Peer reviews happen independently between sessions, with a self-review alternative; customer research and user tests still require actual relevant people.

The facilitator guide matches the existing private broadcast format: host teaching, silent individual work, and selected private written questions. It does not assume student microphones, breakout rooms, a visible attendance roster, or a public chat. It makes no unverified promise of awards, grants, investment, judges, partners, guests, or recordings.

## Sources and maintenance

The 18 primary-source pages in `sources.mjs` were opened at their publishers on September 14, 2026. Two obsolete YC user-interview URLs returned errors and were excluded. Old SBA deep links redirected to its current planning hub, which is the included destination. Optional links do not replace the original required material.

Recheck links before a new cohort. If a publisher moves a page, update the source URL and rebuild. Do not download or rehost third-party videos, paid articles, or proprietary templates. The original lessons and worksheets remain usable if an optional publisher link is unavailable.
