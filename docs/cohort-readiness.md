# Winter curriculum preparation

`scripts/cohort-readiness-winter.mjs` prepares a separate Winter 2026 curriculum from a complete, read-only MCP snapshot. It has no database connection, credential handling, event scheduling, or apply mode. Generated teaching content must stay in private storage or an ignored working directory because this repository is public.

The current reviewed target is December 14, 2026–February 12, 2027. The preparer refuses changed target dates/status, existing Winter content, incomplete snapshots, or workbook sources that differ from the current live lesson text. These guards require a fresh review instead of overwriting later edits.

## Prepare and test

Save a full MCP content snapshot with `cohorts`, `modules`, `lessons`, `resources`, `events`, and `kickoffs` arrays. Each entry is the MCP `{ record, hash }` envelope. Paginate until every table is complete. Do not add users, enrollments, or payment information.

```sh
node --test scripts/cohort-readiness-winter.test.mjs
node scripts/cohort-readiness-winter.mjs /private/snapshot.json /original/repository /private/winter-curriculum
```

The original repository must have its private `content/course-launch/generated/` sources, existing Fall manifest, installed Playwright/Chrome, and built MCP schemas. The resulting `manifest.json` includes stable new identities, local material paths, SHA-256 digests, and twelve MCP requests named `preview-01.json` through `preview-12.json`. Every request has `dry_run: true`; none changes an existing Fall row.

## What is copied

- Ten modules, fifty lessons, and thirty-six cohort resources receive distinct Winter identities. The twenty-six existing global resources remain shared.
- Nine printable workbooks and nine editable Markdown files receive Winter dates and new Winter lesson links. PDFs are planned in both private buckets, yielding twenty-seven new storage objects.
- Nine evergreen CSV templates reuse their eighteen existing private storage objects. Their old storage folder name is an internal identifier; the files contain no Fall dates and are unchanged.
- The supplementary thirteen-lesson field guide is labeled optional practice across Weeks 1–3. Required work follows the main weekly workbook, avoiding an extra ten-interview Week 1 deadline.
- Historical publisher-link check dates remain truthful. Preparing a Winter copy does not claim external links were rechecked.

## Review and publication

1. Inspect the output and each PDF, checking dates, lesson links, pagination, and table legibility.
2. Validate upload payloads with `batch0_upload_material` and content batches with `batch0_upsert_content`, both in dry-run mode. Include each new module before its lessons in the same batch.
3. If publication is authorized, use the existing scoped MCP publishing workflow in `docs/mcp.md`. Upload and verify materials before inserting content. Keep a receipt journal; no storage overwrite is supported.
4. Read back every inserted row and compare every submitted field with the manifest. Verify private downloads using an enrolled Winter account. Metadata and content previews alone do not prove student access to storage objects.
5. If an operation times out or partially succeeds, inspect current records and receipts before retrying. Stable identities prevent a new identity on retries, but existing rows still require fresh MCP hashes.

Live scheduling is separate. These curriculum windows do not commit workshop or office-hour times and do not decide the December 24/31 holiday policy. Preserve the hosted Batch0 Live implementation; null Daily room fields are intentional. Do not rerun historical Fall `prepare-kickoff.mts` or `prepare-course-schedule.mts` to provision Winter.
