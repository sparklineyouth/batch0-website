# Batch0 MCP

The local MCP server lets a trusted assistant read Batch0 course operations and prepare or publish teaching content. It uses the official TypeScript MCP SDK over stdio. A CLI calls the same validated operations for scripts and sessions whose MCP tool list cannot refresh immediately.

## Install and verify

From the website repository:

```sh
cd mcp
npm ci
npm test
cd ..
node mcp/dist/cli.js batch0_status
```

Node 22 or newer is required. The MCP package and lockfile are independent of the Next.js app. `npm test` builds the server and runs isolated tests; no production data is changed by tests.

The server loads the repository `.env.local` automatically. Required values are `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Set `BATCH0_ENV_FILE` to an absolute path to use another environment file. Existing process variables take priority. Never copy secret keys into MCP configuration, tool input, or a tracked file.

## Connect an MCP host

Use an absolute path to the built server. The working directory does not matter.

```json
{
  "mcpServers": {
    "batch0": {
      "command": "node",
      "args": ["/absolute/path/to/batch0-website/mcp/dist/index.js"]
    }
  }
}
```

For a Codex TOML configuration, use:

```toml
[mcp_servers.batch0]
command = "node"
args = ["/absolute/path/to/batch0-website/mcp/dist/index.js"]
```

These examples are read-only. Content tools still appear because their default mode previews changes. To enable intentional publishing in a trusted host, add `BATCH0_MCP_ALLOW_WRITES = "true"` to that server's environment and use `dry_run: false` on the specific tool call. No process-wide configuration is installed by this package.

Run `node mcp/dist/index.js --help` for startup help. Normal server stdout carries only MCP protocol messages; errors use stderr.

## Tools

| Tool | Purpose |
| --- | --- |
| `batch0_status` | Database access, cohort dates/status, content counts, write mode. No student or payment data. |
| `batch0_list_records` | Paginated allowlisted tables: `cohorts`, `modules`, `lessons`, `resources`, `events`, `cohort_kickoff`. Compact by default. |
| `batch0_get_record` | Full record and SHA-256 update hash. For `cohort_kickoff`, `id` means the cohort UUID. |
| `batch0_upsert_content` | Preview/apply up to 25 modules, lessons, and resources; no deletions. |
| `batch0_save_kickoff` | Preview/apply the kickoff page's copy, timing label, join link, agenda, checklist, and note. |
| `batch0_upload_material` | Preview/upload original UTF-8 text/HTML source or base64-encoded PDF into private storage. |

Every input object rejects unknown keys. Tool schemas carry field constraints. Read tools paginate with `limit` (1–100), `offset`, `total`, and `next_offset`. Use `cohort_id` for modules/resources/events, `module_id` for lessons, and `global_only` for unscoped content. `include_content: true` returns full records plus update hashes. A large response fails clearly instead of truncating content silently; reduce the page size.

### Read example

Save input as a JSON file, or use `-` to read JSON from stdin:

```json
{
  "table": "modules",
  "cohort_id": "6350c6ac-70f0-4f53-93d5-c99e397185a9",
  "include_content": true,
  "limit": 20
}
```

```sh
node mcp/dist/cli.js batch0_list_records /absolute/path/to/input.json
```

### Publish course content

1. Read the target cohort and existing records. Preserve their IDs and authored content unless intentionally updating it.
2. Upload original private materials first. Use the returned storage path in `lessons.materials` or `resources.storage_path`.
3. Assign stable UUIDs to new records. Put modules before lessons that reference them.
4. For existing records, copy the hash returned by `batch0_get_record` into that change's `expected_hash`.
5. Preview and inspect the changed fields. Apply the same request with `dry_run: false` in a process with writes enabled.
6. Read every affected record again. The course/event content cache can take 60 seconds to refresh.

```json
{
  "changes": [
    {
      "table": "modules",
      "record": {
        "id": "a4200000-0000-4000-8000-000000000001",
        "cohort_id": "6350c6ac-70f0-4f53-93d5-c99e397185a9",
        "week": 2,
        "title": "Example module — replace before publishing",
        "summary": "A complete lesson objective.",
        "position": 1
      }
    }
  ],
  "dry_run": true,
  "reason": "Prepare reviewed course materials for the cohort kickoff"
}
```

```sh
node mcp/dist/cli.js batch0_upsert_content /absolute/path/to/preview.json
BATCH0_MCP_ALLOW_WRITES=true node mcp/dist/cli.js batch0_upsert_content /absolute/path/to/apply.json
```

Missing optional fields preserve existing values. Passing `null` explicitly clears a nullable field. Existing rows require a current hash even if the proposed values are unchanged. Moving a record to a different cohort/module is intentionally unsupported. New records with a duplicate title in the same scope are rejected instead of silently duplicating content.

Text uploads are limited to 200,000 characters and 400,000 UTF-8 bytes; PDF uploads to 2 MiB decoded. Both use private buckets `course-materials`/`resources`, and storage prefixes `mcp/`/`course-launch/`. They never overwrite an existing object. For a revised material use a new versioned path, then update the content reference. HTML source is parsed and rejects active elements, event handlers, remote assets, and CSS imports/URLs; it accepts static text, tables, and print CSS. Supabase intentionally serves HTML as plain text, so use PDF for a workbook students can view and print in the browser. Supply `pdf_base64` instead of `text` with a `.pdf` path. The PDF envelope must have a supported header and final EOF marker; explicit active actions and embedded files are rejected. This is not a malware scanner: upload original PDFs generated from the reviewed teaching materials. No source URL is downloaded; cite external resources with HTTPS links instead of copying their copyrighted contents.

### Kickoff page

`batch0_save_kickoff` takes `cohort_id`, `record`, `reason`, optional `expected_hash`, and `dry_run`. `record` allows `headline`, `intro`, `time_label`, `location_label`, `join_url`, `agenda: [{title, body}]`, `checklist: [{label, href}]`, and `note`. Unspecified fields stay unchanged. Explicit null restores the app's default. Checklist links are site-relative or HTTPS; a join link must be HTTPS.

This tool changes the kickoff **page**, not an event or room. Scheduling hosted video requires the app's event service so Daily room creation, expiry, and access control remain intact. The MCP intentionally cannot send notifications, email, Discord messages, advertisements, or payment requests.

## Security and failure behavior

- The authenticated destination is restricted to an HTTPS Supabase project origin. Redirects are refused. No user-supplied endpoint, SQL, table name, RPC, or arbitrary file-read tool exists.
- The service key stays local. It is powerful and bypasses database row-level policies, so only trusted local hosts should launch this process. Do not expose this stdio server as an unauthenticated network endpoint.
- Only explicit content fields are read. User profiles, enrollment identities, payments, credentials, role changes, and financial operations are not exposed.
- Publishing requires both the write-enabled process and an explicit non-preview tool input. Preview creates no audit entry and performs no mutations.
- Every real operation durably appends an intent entry before mutation to `mcp/.audit/operations.jsonl` (directory mode 700, file mode 600). It records IDs, reason, operation, and hashes; authored body text and credentials are omitted. `BATCH0_MCP_AUDIT_PATH` overrides the location. Symlink audit files are rejected.
- Each request has a 15-second timeout. Provider response bodies are never reflected in tool errors because they may contain supplied content. A failed/timeout write may have succeeded remotely: inspect the record/object and audit before retrying.
- A batch is prevalidated, then applied **sequentially, not transactionally**. A failure returns `success: false`, the operation ID, and completed rows. The CLI exits unsuccessfully. Inspect those rows before retrying; there is no automatic rollback.
- Hashes are checked during validation and immediately before each write. Resources and kickoff updates also condition on `updated_at`. Modules/lessons do not have a version column, so their check and write have a narrow concurrent-edit race. Avoid simultaneous editors during bulk publishing; use a database compare-and-swap migration if concurrent automated writers become necessary.
- An audit-storage failure after a database write cannot undo that write. Use returned IDs/readback to establish the final state. Retain reviewed content and pre-edit snapshots outside the audit trail if rollback may be needed.

## Validation

`npm test --prefix mcp` covers a real SDK client/server stdio round trip against an isolated HTTP fixture, tool discovery and input schemas, pagination, safe defaults, references, duplicate prevention, stale hashes, partial failures, private upload semantics, kickoff links, and audit privacy. Live `batch0_status` was additionally verified read-only on the configured project on 2026-09-14.

Storage behavior: [Supabase files and HTML restrictions](https://supabase.com/docs/guides/storage/quickstart#files).

Ten stable, read-only assistant evaluation cases with wholly synthetic public-safe data and their isolated fixture server are available under `mcp/evaluations/`. Expected answers are verified through 23 paginated tool reads. This verifies the cases, not an external model score.

Protocol references: [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), and [tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
