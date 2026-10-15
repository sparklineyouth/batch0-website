/**
 * Run every database migration batch0's database still needs.
 *
 *   npm run db:migrate              # plan only: what would run, and why
 *   npm run db:migrate -- --apply   # back up, then run them, in order
 *
 * Which ones are pending (lib/migration-plan.ts), decided per file from its
 * OWN evidence: recorded by the Supabase CLI, its verify query passes
 * (docs/migrations-2026-10.md), or every table it creates exists. A file that
 * can't tell on its own (it creates no tables) counts as live when a later
 * file proves it ran. Production's history was partly run by hand in the SQL
 * editor, so neither `supabase db push` (would re-run live-but-unrecorded
 * files) nor "run them all" is safe; this is.
 *
 * A GAP — an older file whose tables are missing although later files ran —
 * stops the run before anything changes: running an old, non-idempotent file
 * late can do damage, and recording it unrun would hide the hole. Inspect it,
 * then rerun with --allow-gaps (run it) or --mark-applied=NNNN (record only).
 *
 * With --apply, in order:
 *   1. Takes an advisory lock, so two runs can't interleave.
 *   2. Deploy gate: a migration that removes what the previous code reads
 *      (0101 drops Discord) runs only once the code that replaced it is live
 *      on https://batch0.org — files before it still run.
 *   3. Backs up to backups/<time>/ (gitignored and vercelignored: it holds
 *      personal data): pg_dump of the public schema when a pg_dump that
 *      matches the server is installed, and always a JSONL snapshot of every
 *      table a pending file drops, drops columns from, updates or deletes from.
 *   4. Runs each pending file in one transaction, with its verify query
 *      checked before COMMIT — any error rolls the whole file back. Waits at
 *      most 4s for a lock (a busy table) and tries again twice.
 *   5. Records each file in supabase_migrations.schema_migrations (creating
 *      that table if the project never had it), plus the ones found live but
 *      unrecorded, so `supabase migration list` agrees from then on.
 *   6. Tells PostgREST to reload its schema cache, then re-checks everything.
 *
 * Connection: SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL_NON_POOLING /
 * POSTGRES_URL) in .env.local — Supabase dashboard → Connect → "Session
 * pooler" connection string, with the database password filled in
 * (percent-encode @ : / # ? % in it). Or, with the CLI linked
 * (`supabase link`), SUPABASE_DB_PASSWORD alone.
 *
 * Flags:
 *   --apply                 actually run (default: plan only, changes nothing)
 *   --only=0101,0102        run just these pending versions
 *   --site=https://…        production URL for the deploy gate (default
 *                           https://batch0.org — never .env.local's)
 *   --skip-deploy-check     run gated migrations without the HTTP check
 *   --allow-gaps            run gap files too (after you've looked at them)
 *   --mark-applied=0086     record these versions as applied without running
 *                           them (they're live, history just lacks them)
 *   --no-backup             skip the backup (not recommended)
 *   --allow-other-project   the database isn't the project in
 *                           NEXT_PUBLIC_SUPABASE_URL, and that's intended
 *
 * Exit codes: 0 done (or plan printed), 1 a migration failed, 2 setup problem
 * (no connection string, wrong project, bad flag, gaps found), 3 stopped at a
 * deploy gate (everything before it ran; deploy, then run it again), 4 another
 * run holds the lock.
 */

import { createWriteStream, existsSync, readFileSync, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import {
  DEPLOY_GATES,
  parseMigrationFile,
  planMigrations,
  sessionConnectionString,
  supabaseProjectRef,
  touchedTables,
  type MigrationFile,
  type PlannedMigration,
} from "../lib/migration-plan.ts";
import {
  applyWithRetry,
  describeError,
  ensureHistory,
  MigrationError,
  readState,
  recordVersion,
  type Db,
} from "../lib/migration-runner.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const PRODUCTION_SITE = "https://batch0.org";
const SNAPSHOT_ROW_CAP = 500_000;

/** Thrown instead of exiting, so the lock and connection are always released first. */
class Exit extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}
const fail = (message: string, code = 1): never => {
  throw new Exit(message, code);
};
const say = (m = "") => console.log(m);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
function option(name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}
const list = (name: string) =>
  option(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const KNOWN = new Set([
  "apply",
  "only",
  "site",
  "skip-deploy-check",
  "allow-gaps",
  "mark-applied",
  "no-backup",
  "allow-other-project",
  "help",
]);

// ---------------------------------------------------------------------------
// Which database
// ---------------------------------------------------------------------------

function resolveDbUrl(): { url: string; source: string } | null {
  for (const name of ["SUPABASE_DB_URL", "DATABASE_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"]) {
    const v = process.env[name]?.trim();
    if (v) return { url: v, source: name };
  }
  // A linked Supabase CLI keeps the pooler URL (no password) here.
  const pooler = path.join(ROOT, "supabase", ".temp", "pooler-url");
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (existsSync(pooler) && password) {
    try {
      const u = new URL(readFileSync(pooler, "utf8").trim());
      u.password = encodeURIComponent(password);
      return { url: u.toString(), source: "supabase/.temp/pooler-url + SUPABASE_DB_PASSWORD" };
    } catch {
      /* fall through to the instructions */
    }
  }
  return null;
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    return fail(
      "The connection string isn't a valid URL. If the password contains @ : / # ? or %, percent-encode it\n" +
        "  (@ → %40, : → %3A, / → %2F, # → %23, ? → %3F, % → %25), or put it in SUPABASE_DB_PASSWORD instead.",
      2,
    );
  }
}

function decodedPassword(u: URL): string {
  try {
    return decodeURIComponent(u.password);
  } catch {
    return u.password;
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "REDACTED";
    return u.toString();
  } catch {
    return "(unparseable connection string)";
  }
}

const isLocalHost = (host: string) => /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(host);
const isTlsError = (err: unknown) =>
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(`${(err as { code?: string }).code ?? ""} ${(err as Error)?.message ?? ""}`);

async function connect(url: string): Promise<pg.Client> {
  const parsed = parseUrl(url);
  const sslmode = parsed.searchParams.get("sslmode");
  // Only what node-postgres understands goes in the string; TLS is set below,
  // because pg reads sslmode=require as "verify the certificate", which
  // Supabase's own CA fails in Node.
  const clean = new URL(parsed.toString());
  clean.search = "";
  const base = {
    host: clean.hostname,
    port: Number(clean.port || 5432),
    user: decodeURIComponent(clean.username),
    password: decodedPassword(parsed),
    database: decodeURIComponent(clean.pathname.replace(/^\//, "")) || "postgres",
    application_name: "batch0 db:migrate",
    connectionTimeoutMillis: 20_000,
  };
  const attempt = async (ssl: pg.ClientConfig["ssl"]) => {
    const client = new pg.Client({ ...base, ssl });
    client.on("error", (err) => console.error(`\n✗ Lost the database connection: ${describeError(err)}`));
    await client.connect();
    return client;
  };

  if (sslmode === "disable" || (isLocalHost(parsed.hostname) && !sslmode)) return attempt(false);
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) return attempt({ ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true });
  // Asked for verification explicitly: never fall back.
  if (sslmode === "verify-full" || sslmode === "verify-ca") return attempt({ rejectUnauthorized: true });
  try {
    return await attempt({ rejectUnauthorized: true });
  } catch (err) {
    if (!isTlsError(err)) throw err;
    say("  note  Supabase's certificate isn't in Node's trust store, so this connection is encrypted but the");
    say("        certificate isn't verified. To verify it: download the CA (Project Settings → Database → SSL)");
    say("        and set PGSSLROOTCERT=/path/to/prod-ca.crt.");
    return attempt({ rejectUnauthorized: false });
  }
}

function adapter(client: pg.Client): Db {
  return {
    async query(sql, params) {
      const r = (await client.query(sql, params as unknown[] | undefined)) as unknown as pg.QueryResult | pg.QueryResult[];
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return { rows: last?.rows ?? [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Deploy gate
// ---------------------------------------------------------------------------

/** Does `path` on the live site redirect to `expectLocation`? Follows host-only hops (apex → www). */
async function redirectsTo(site: string, gatePath: string, expectLocation: string): Promise<{ ok: boolean; detail: string }> {
  let url = new URL(gatePath, site);
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", headers: { "user-agent": "batch0-db-migrate" }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      return { ok: false, detail: `couldn't reach ${url.origin}: ${(err as Error).message}` };
    }
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) return { ok: false, detail: `${url} answered ${res.status}` };
    const next = new URL(loc, url);
    if (next.pathname === url.pathname) {
      url = next; // apex → www, http → https
      continue;
    }
    const ok = next.pathname === expectLocation || next.pathname.startsWith(`${expectLocation}/`);
    return { ok, detail: `${url} → ${res.status} ${next.pathname}` };
  }
  return { ok: false, detail: `too many redirects from ${gatePath}` };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function pgDump(url: string, file: string): { ok: boolean; detail: string } {
  const probe = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { ok: false, detail: "pg_dump isn't installed" };
  const parsed = parseUrl(url);
  // libpq accepts only its own query parameters (Vercel's ?supa=… isn't one).
  const u = new URL(parsed.toString());
  u.password = "";
  u.search = "";
  const sslmode = parsed.searchParams.get("sslmode") ?? (isLocalHost(parsed.hostname) ? null : "require");
  if (sslmode) u.searchParams.set("sslmode", sslmode);
  const password = decodedPassword(parsed);
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password; // otherwise the user's own PGPASSWORD / ~/.pgpass apply
  const run = spawnSync(
    "pg_dump",
    ["--dbname", u.toString(), "--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--file", file],
    { encoding: "utf8", env, timeout: 15 * 60_000 },
  );
  if (run.status === 0) return { ok: true, detail: `${probe.stdout.trim()} → ${path.relative(ROOT, file)}` };
  const why = (run.stderr || run.error?.message || "unknown error").trim().split("\n").slice(-2).join(" ");
  return { ok: false, detail: `pg_dump failed: ${why}` };
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function writeLine(out: WriteStream, line: string): Promise<void> {
  if (!out.write(line)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
}

/** Every row of each table, one JSON object per line, from one consistent snapshot, through a cursor. */
async function snapshot(client: pg.Client, tables: string[], dir: string): Promise<string[]> {
  const written: string[] = [];
  await client.query("begin isolation level repeatable read read only");
  try {
    for (const t of tables) {
      const { rows } = await client.query(`select count(*)::bigint as n from public.${quoteIdent(t)}`);
      const n = Number(rows[0].n);
      if (n > SNAPSHOT_ROW_CAP) {
        say(`  warn  ${t}: ${n} rows, over the snapshot cap (${SNAPSHOT_ROW_CAP}) — rely on pg_dump or a Supabase backup for it`);
        continue;
      }
      const out = createWriteStream(path.join(dir, `${t}.jsonl`), { mode: 0o600 });
      await client.query(`declare snap no scroll cursor for select to_jsonb(t) as r from public.${quoteIdent(t)} t`);
      for (;;) {
        const page = await client.query("fetch 2000 from snap");
        for (const row of page.rows) await writeLine(out, `${JSON.stringify(row.r)}\n`);
        if (page.rows.length < 2000) break;
      }
      await client.query("close snap");
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      written.push(`${t} (${n} rows)`);
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printPlan(plan: PlannedMigration[], heading: string) {
  const count = (s: string) => plan.filter((p) => p.status === s).length;
  const unrecorded = plan.filter((p) => p.status === "unrecorded");
  say(`\n${heading}`);
  say(
    `  ${plan.length} files · ${count("applied")} recorded · ${unrecorded.length} live but unrecorded · ${count("pending")} pending` +
      (count("gap") ? ` · ${count("gap")} GAP` : ""),
  );
  // The unrecorded list is long on a hand-migrated database. Files proven by
  // their own evidence are listed newest first; the inferred ones are counted.
  const inferred = unrecorded.filter((p) => p.why.startsWith("a later migration"));
  const proven = unrecorded.filter((p) => !p.why.startsWith("a later migration"));
  if (inferred.length) say(`  …${inferred.length} files with no tables of their own count as live because later files ran`);
  const shown = proven.slice(-12);
  if (proven.length > shown.length) say(`  …${proven.length - shown.length} older files whose own tables exist`);
  for (const p of shown) say(`  live     ${p.file.padEnd(42)} ${p.why}`);
  for (const p of plan.filter((p) => p.status === "gap")) say(`  GAP      ${p.file.padEnd(42)} ${p.why}`);
  for (const p of plan.filter((p) => p.status === "pending")) say(`  PENDING  ${p.file.padEnd(42)} ${p.why}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function loadMigrations(): Promise<MigrationFile[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const files: MigrationFile[] = [];
  for (const f of names) {
    const parsed = parseMigrationFile(f, await readFile(path.join(MIGRATIONS_DIR, f), "utf8"));
    if (parsed) files.push(parsed);
    else say(`  warn  skipping ${f}: not named NNNN_name.sql`);
  }
  return files;
}

async function main(): Promise<void> {
  for (const a of argv) {
    const name = a.replace(/^--/, "").split("=")[0];
    if (a.startsWith("--") && !KNOWN.has(name)) fail(`Unknown flag ${a}. Run with --help.`, 2);
  }
  if (flag("help")) {
    const src = readFileSync(new URL(import.meta.url), "utf8");
    console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/")).replace(/^ \* ?/gm, ""));
    return;
  }
  const APPLY = flag("apply");
  const ONLY = list("only");
  const MARK = list("mark-applied");
  say(`batch0 db:migrate — ${APPLY ? "APPLY" : "plan only (nothing will change; add --apply to run)"}`);

  const resolved = resolveDbUrl();
  if (!resolved) {
    fail(
      [
        "No database connection string.",
        "  Supabase dashboard → your project → Connect → \"Session pooler\" → copy the URI,",
        "  replace [YOUR-PASSWORD] with the database password (Project Settings → Database),",
        "  and add it to .env.local as:",
        "    SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres",
        "  (Or, with the Supabase CLI linked, set SUPABASE_DB_PASSWORD.) Then run this again.",
      ].join("\n"),
      2,
    );
  }
  const session = sessionConnectionString(resolved!.url);
  const dbUrl = session.url;
  parseUrl(dbUrl);
  say(`  db    ${redact(dbUrl)}  (from ${resolved!.source}${session.changed ? "; moved from the transaction port 6543 to the session port 5432" : ""})`);

  // Never migrate a different project than the app points at by accident.
  const appRef = supabaseProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const dbRef = supabaseProjectRef(dbUrl);
  if (appRef && dbRef && appRef !== dbRef && !flag("allow-other-project")) {
    fail(
      `The connection string is for Supabase project ${dbRef}, but NEXT_PUBLIC_SUPABASE_URL is project ${appRef}.\n` +
        "  Fix whichever is wrong, or pass --allow-other-project if this is deliberate.",
      2,
    );
  }
  if (dbRef) say(`  ref   ${dbRef}${appRef === dbRef ? " (matches NEXT_PUBLIC_SUPABASE_URL)" : ""}`);

  const migrations = await loadMigrations();
  let client: pg.Client;
  try {
    client = await connect(dbUrl);
  } catch (err) {
    if (err instanceof Exit) throw err;
    return fail(`Couldn't connect: ${describeError(err)}`, 2);
  }
  const db = adapter(client);
  let locked = false;
  try {
    const lock = await db.query(`select pg_try_advisory_lock(hashtext('batch0:db-migrate')) as ok`);
    if (!lock.rows[0]?.ok) fail("Another db:migrate run holds the lock on this database. Wait for it to finish.", 4);
    locked = true;

    const before = planMigrations(migrations, await readState(db, migrations));
    printPlan(before, "Before");

    for (const v of MARK) {
      if (!before.some((p) => p.version === v)) fail(`--mark-applied names ${v}, which isn't a migration file`, 2);
    }
    // Gaps stop everything unless they're dealt with explicitly.
    const gaps = before.filter((p) => p.status === "gap" && !MARK.includes(p.version));
    if (gaps.length && !flag("allow-gaps")) {
      fail(
        `${gaps.length === 1 ? "1 file looks" : `${gaps.length} files look`} skipped although later files ran: ${gaps.map((p) => p.file).join(", ")}.\n` +
          "  Nothing was changed. Look at each one: if it really never ran, rerun with --allow-gaps to run it\n" +
          "  (it runs late, after newer files — read it first); if its effects are live and only the history\n" +
          "  is wrong, rerun with --mark-applied=" + gaps.map((p) => p.version).join(",") + " to record it without running.",
        2,
      );
    }
    let pending = before.filter((p) => p.status === "pending" || (p.status === "gap" && !MARK.includes(p.version)));
    pending = pending.filter((p) => !MARK.includes(p.version));
    if (ONLY.length) {
      const missing = ONLY.filter((v) => !pending.some((p) => p.version === v));
      if (missing.length) fail(`--only names versions that aren't pending: ${missing.join(", ")}`, 2);
      pending = pending.filter((p) => ONLY.includes(p.version));
    }
    const unrecorded = before.filter((p) => p.status === "unrecorded" || MARK.includes(p.version));

    if (!APPLY) {
      say(pending.length ? `\nWould run ${pending.length}: ${pending.map((p) => p.version).join(", ")}` : "\nNothing to run: the database is up to date.");
      for (const p of pending) {
        const gate = DEPLOY_GATES[p.version];
        if (gate) say(`  gate  ${p.version}: ${gate.why}. Checked before it runs.`);
      }
      say("\nNothing was changed. To back up and apply: npm run db:migrate -- --apply");
      return;
    }

    // Deploy gates, before anything is written. Files before the first one
    // that's held back still run; it and everything after it wait.
    const site = option("site") ?? PRODUCTION_SITE;
    let heldBack: { version: string; message: string } | null = null;
    for (const p of pending) {
      const gate = DEPLOY_GATES[p.version];
      if (!gate) continue;
      if (flag("skip-deploy-check")) {
        say(`  warn  ${p.version}: deploy check skipped (--skip-deploy-check)`);
        continue;
      }
      const live = await redirectsTo(site, gate.path, gate.expectLocation);
      if (live.ok) {
        say(`  ok    ${p.version}: the new code is live (${live.detail})`);
        continue;
      }
      heldBack = {
        version: p.version,
        message:
          `${p.version} is held back: ${gate.why}.\n` +
          `  Checked ${site}${gate.path} expecting a redirect to ${gate.expectLocation}; got ${live.detail}.\n` +
          "  Deploy the code first (merge to main and wait for Vercel), then run this again.\n" +
          "  Wrong site? Pass --site=https://your-domain. Already sure? --skip-deploy-check.",
      };
      break;
    }
    if (heldBack) {
      const cut = pending.findIndex((p) => p.version === heldBack!.version);
      const waiting = pending.slice(cut).map((p) => p.version);
      pending = pending.slice(0, cut);
      if (pending.length === 0 && unrecorded.length === 0) fail(`${heldBack.message}\n  Nothing was changed.`, 3);
      say(`\n  hold  ${waiting.join(", ")} wait for the deploy; running the ${pending.length} before ${heldBack.version} now.`);
    }

    if (pending.length > 0 && !flag("no-backup")) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(ROOT, "backups", stamp);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      say(`\nBacking up to ${path.relative(ROOT, dir)}/ (gitignored and vercelignored — it holds personal data; keep it private)`);
      const dump = pgDump(dbUrl, path.join(dir, "public.dump"));
      say(`  ${dump.ok ? "ok  " : "warn"}  ${dump.detail}`);
      const state = await readState(db, migrations);
      const touched = Array.from(new Set(pending.flatMap((p) => touchedTables(p.sql)))).filter((t) => state.existingTables.has(t)).sort();
      try {
        const snap = await snapshot(client, touched, dir);
        say(`  ok    snapshot of what the pending files remove or rewrite: ${snap.length ? snap.join(", ") : "nothing to snapshot"}`);
      } catch (err) {
        if (!dump.ok) fail(`Backup failed (no usable pg_dump, and the snapshot failed: ${describeError(err)}). Nothing was changed. Pass --no-backup to run anyway.`, 2);
        say(`  warn  snapshot failed (${describeError(err)}); the pg_dump above covers it`);
      }
    } else if (pending.length > 0) {
      say("\n  warn  --no-backup: running without a backup");
    }

    const history = await ensureHistory(db);
    if (pending.length) say(`\nRunning ${pending.length} migration${pending.length === 1 ? "" : "s"}:`);
    const tty = !!process.stdout.isTTY;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      // A version two files share (0071) is recorded only with the last of them.
      const record = !pending.slice(i + 1).some((q) => q.version === p.version);
      const started = Date.now();
      if (tty) process.stdout.write(`  …     ${p.file}`);
      try {
        await applyWithRetry(db, p, {
          history,
          record,
          onRetry: (attempt, waitMs) => {
            if (tty) process.stdout.write("\n");
            say(`  wait  ${p.file}: a table it needs is busy (lock timeout); trying again in ${waitMs / 1000}s (retry ${attempt}/2)`);
          },
        });
      } catch (err) {
        if (tty) process.stdout.write("\n");
        const e = err instanceof MigrationError ? err : new MigrationError(p.file, describeError(err), false, err);
        fail(
          `${e.message}\n` +
            (e.rolledBack ? "  Nothing from this file was kept. " : "  ") +
            "Files before it are applied and recorded; nothing after it ran.\n" +
            "  Fix the cause and run the same command again — finished files are skipped.",
        );
      }
      process.stdout.write(`${tty ? "\r" : ""}  ok    ${p.file}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    }

    // Live but unrecorded (and --mark-applied): record them, so the CLI's history matches the database.
    if (unrecorded.length) {
      for (const p of unrecorded) await recordVersion(db, p, history);
      say(`\nRecorded ${unrecorded.length} live-but-unrecorded file${unrecorded.length === 1 ? "" : "s"} in supabase_migrations, so \`supabase migration list\` agrees.`);
    }

    // PostgREST caches the schema; new tables 404 through the API until it reloads.
    await db.query(`notify pgrst, 'reload schema'`).catch(() => undefined);

    const after = planMigrations(migrations, await readState(db, migrations));
    printPlan(after, "After");
    if (heldBack) fail(`${heldBack.message}\n  Everything before ${heldBack.version} is applied.`, 3);
    const left = after.filter((p) => p.status === "pending" || p.status === "gap");
    if (left.length && !ONLY.length) fail(`${left.length} still pending: ${left.map((p) => p.version).join(", ")}`);
    say(left.length ? "\nDone (the rest were left out by --only)." : "\nDone: every migration is applied and verified.");
    if (pending.some((p) => p.version === "0101")) {
      say("\nAfter 0101: grant chat.manage at /admin/roles to any non-admin role that should run Chat");
      say("(0101 deliberately removes discord.manage without converting it; '*' admins already run Chat).");
    }
  } finally {
    if (locked) await db.query(`select pg_advisory_unlock(hashtext('batch0:db-migrate'))`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof Exit) {
      console.error(`\n✗ ${err.message}`);
      process.exit(err.code);
    }
    console.error(`\n✗ ${describeError(err)}`);
    process.exit(1);
  },
);
