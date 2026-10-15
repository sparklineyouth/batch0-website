/**
 * Run every database migration batch0's database still needs.
 *
 *   npm run db:migrate              # plan only: what would run, and why
 *   npm run db:migrate -- --apply   # back up, then run them, in order
 *
 * Which ones are pending (lib/migration-plan.ts): a file counts as applied
 * when the Supabase CLI recorded it, when its verify query passes
 * (docs/migrations-2026-10.md), or when a later migration shows it ran.
 * Production's history was partly run by hand in the SQL editor, so neither
 * `supabase db push` (would re-run live-but-unrecorded files) nor "run them
 * all" is safe; this is.
 *
 * With --apply, in order:
 *   1. Takes an advisory lock, so two runs can't interleave.
 *   2. Deploy gate: a migration that removes what the previous code reads
 *      (0101 drops Discord) runs only once the code that replaced it is live
 *      — checked over HTTP against the production site.
 *   3. Backs up to backups/<time>/ (gitignored: it holds personal data):
 *      pg_dump of the public schema when pg_dump is installed and matches
 *      the server, and always a JSONL snapshot of every table a pending file
 *      drops, drops columns from, updates or deletes from.
 *   4. Runs each pending file in one transaction, with its verify query
 *      checked before COMMIT — any error rolls the whole file back.
 *   5. Records each file in supabase_migrations.schema_migrations (and the
 *      ones found live but unrecorded), so `supabase migration list` agrees.
 *   6. Tells PostgREST to reload its schema cache, then re-checks everything.
 *
 * Connection: SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL_NON_POOLING /
 * POSTGRES_URL) in .env.local — Supabase dashboard → Connect → "Session
 * pooler" connection string, with the database password filled in. Or, with
 * the CLI linked (`supabase link`), SUPABASE_DB_PASSWORD alone.
 *
 * Flags:
 *   --apply                 actually run (default: plan only, changes nothing)
 *   --only=0101,0102        run just these pending versions
 *   --site=https://…        production URL for the deploy gate (default:
 *                           NEXT_PUBLIC_SITE_URL unless it's localhost, else
 *                           https://batch0.org)
 *   --skip-deploy-check     run gated migrations without the HTTP check
 *   --no-backup             skip the backup (not recommended)
 *   --allow-other-project   the database isn't the project in
 *                           NEXT_PUBLIC_SUPABASE_URL, and that's intended
 *
 * Exit codes: 0 done (or plan printed), 1 a migration failed, 2 setup problem
 * (no connection string, wrong project, bad flag), 3 stopped at a deploy gate
 * (everything before it ran; deploy, then run it again).
 */

import { createWriteStream, existsSync, readFileSync } from "node:fs";
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
  applyMigration,
  describeError,
  historyColumns,
  MigrationError,
  readState,
  recordVersion,
  type Db,
} from "../lib/migration-runner.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SNAPSHOT_ROW_CAP = 500_000;

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
const known = new Set(["apply", "only", "site", "skip-deploy-check", "no-backup", "allow-other-project", "help"]);
for (const a of argv) {
  const name = a.replace(/^--/, "").split("=")[0];
  if (a.startsWith("--") && !known.has(name)) fail(`Unknown flag ${a}. Run with --help.`, 2);
}
if (flag("help")) {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/")).replace(/^ \* ?/gm, ""));
  process.exit(0);
}
const APPLY = flag("apply");
const ONLY = option("only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function fail(message: string, code = 1): never {
  console.error(`\n✗ ${message}`);
  process.exit(code);
}
const say = (m = "") => console.log(m);

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
      u.password = password;
      return { url: u.toString(), source: "supabase/.temp/pooler-url + SUPABASE_DB_PASSWORD" };
    } catch {
      /* fall through to the instructions */
    }
  }
  return null;
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

async function connect(url: string): Promise<pg.Client> {
  const parsed = new URL(url);
  // TLS is set below, not by the URL: node-postgres reads sslmode=require as
  // "verify the certificate", which Supabase's own CA fails in Node.
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) parsed.searchParams.delete(p);
  const connectionString = parsed.toString();
  const base = { connectionString, application_name: "batch0 db:migrate", connectionTimeoutMillis: 20_000 };

  const attempt = async (ssl: pg.ClientConfig["ssl"]) => {
    const client = new pg.Client({ ...base, ssl });
    client.on("error", (err) => console.error(`\n✗ Lost the database connection: ${describeError(err)}`));
    await client.connect();
    return client;
  };

  if (isLocalHost(parsed.hostname)) return attempt(false);
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) return attempt({ ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true });
  try {
    return await attempt({ rejectUnauthorized: true });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (!/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code + " " + String((err as Error).message))) throw err;
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

function productionSite(): string {
  const given = option("site");
  if (given) return given;
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    if (env && !isLocalHost(new URL(env).hostname)) return env;
  } catch {
    /* default below */
  }
  return "https://batch0.org";
}

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
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  if (!isLocalHost(u.hostname) && !u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  const run = spawnSync(
    "pg_dump",
    ["--dbname", u.toString(), "--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--file", file],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: password }, timeout: 15 * 60_000 },
  );
  if (run.status === 0) return { ok: true, detail: `${probe.stdout.trim()} → ${path.relative(ROOT, file)}` };
  const why = (run.stderr || run.error?.message || "unknown error").trim().split("\n").slice(-2).join(" ");
  return { ok: false, detail: `pg_dump failed: ${why}` };
}

/** Every row of each table, one JSON object per line, from one consistent snapshot. */
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
      const file = path.join(dir, `${t}.jsonl`);
      const out = createWriteStream(file);
      for (let offset = 0; offset < n; offset += 5_000) {
        const page = await client.query(`select to_jsonb(t) as r from public.${quoteIdent(t)} t order by ctid limit 5000 offset ${offset}`);
        for (const row of page.rows) out.write(`${JSON.stringify(row.r)}\n`);
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      written.push(`${t} (${n} rows)`);
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
  return written;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printPlan(plan: PlannedMigration[], heading: string) {
  const applied = plan.filter((p) => p.status === "applied").length;
  const unrecorded = plan.filter((p) => p.status === "unrecorded");
  const pending = plan.filter((p) => p.status === "pending");
  say(`\n${heading}`);
  say(`  ${plan.length} files · ${applied} recorded · ${unrecorded.length} live but unrecorded · ${pending.length} pending`);
  // The unrecorded list can be long on a hand-migrated database: show the newest few.
  const shownUnrecorded = unrecorded.slice(-12);
  if (unrecorded.length > shownUnrecorded.length) say(`  …${unrecorded.length - shownUnrecorded.length} older unrecorded files (a later migration has run)`);
  for (const p of shownUnrecorded) say(`  live     ${p.file.padEnd(42)} ${p.why}`);
  for (const p of pending) say(`  PENDING  ${p.file.padEnd(42)} ${p.why}`);
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

async function main() {
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
  const session = sessionConnectionString(resolved.url);
  const dbUrl = session.url;
  say(`  db    ${redact(dbUrl)}  (from ${resolved.source}${session.changed ? "; moved from the transaction port 6543 to the session port 5432" : ""})`);

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
    fail(`Couldn't connect: ${describeError(err)}`);
  }
  const db = adapter(client);
  let locked = false;
  try {
    const lock = await db.query(`select pg_try_advisory_lock(hashtext('batch0:db-migrate')) as ok`);
    if (!lock.rows[0]?.ok) fail("Another db:migrate run holds the lock on this database. Wait for it to finish.");
    locked = true;

    const before = planMigrations(migrations, await readState(db, migrations));
    printPlan(before, "Before");
    let pending = before.filter((p) => p.status === "pending");
    if (ONLY?.length) {
      const missing = ONLY.filter((v) => !pending.some((p) => p.version === v));
      if (missing.length) fail(`--only names versions that aren't pending: ${missing.join(", ")}`, 2);
      pending = pending.filter((p) => ONLY.includes(p.version));
    }
    const unrecorded = before.filter((p) => p.status === "unrecorded");

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
    const site = productionSite();
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
      if (pending.length === 0) fail(`${heldBack.message}\n  Nothing was changed.`);
      say(`\n  hold  ${waiting.join(", ")} wait for the deploy; running the ${pending.length} before ${heldBack.version} now.`);
    }

    if (pending.length > 0 && !flag("no-backup")) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(ROOT, "backups", stamp);
      await mkdir(dir, { recursive: true });
      say(`\nBacking up to ${path.relative(ROOT, dir)}/ (gitignored — it holds personal data; keep it private)`);
      const dump = pgDump(dbUrl, path.join(dir, "public.dump"));
      say(`  ${dump.ok ? "ok  " : "warn"}  ${dump.detail}`);
      const state = await readState(db, migrations);
      const touched = Array.from(new Set(pending.flatMap((p) => touchedTables(p.sql)))).filter((t) => state.existingTables.has(t)).sort();
      let snap: string[] = [];
      try {
        snap = await snapshot(client, touched, dir);
        say(`  ok    snapshot of what the pending files remove or rewrite: ${snap.length ? snap.join(", ") : "nothing to snapshot"}`);
      } catch (err) {
        if (!dump.ok) fail(`Backup failed (no pg_dump, and the snapshot failed: ${describeError(err)}). Nothing was changed. Pass --no-backup to run anyway.`);
        say(`  warn  snapshot failed (${describeError(err)}); the pg_dump above covers it`);
      }
    } else if (pending.length > 0) {
      say("\n  warn  --no-backup: running without a backup");
    }

    const history = await historyColumns(db);
    if (pending.length) say(`\nRunning ${pending.length} migration${pending.length === 1 ? "" : "s"}:`);
    for (const p of pending) {
      const started = Date.now();
      // A live "…" line rewritten in place on a terminal; plain lines when piped (CI, an agent's shell).
      const tty = !!process.stdout.isTTY;
      if (tty) process.stdout.write(`  …     ${p.file}`);
      try {
        await applyMigration(db, p, { history });
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

    // Live but unrecorded: record them, so the CLI's history matches the database.
    if (history && unrecorded.length) {
      for (const p of unrecorded) await recordVersion(db, p, history);
      say(`\nRecorded ${unrecorded.length} live-but-unrecorded file${unrecorded.length === 1 ? "" : "s"} in supabase_migrations, so \`supabase migration list\` agrees.`);
    }

    // PostgREST caches the schema; new tables 404 through the API until it reloads.
    await db.query(`notify pgrst, 'reload schema'`).catch(() => undefined);

    const after = planMigrations(migrations, await readState(db, migrations));
    printPlan(after, "After");
    const left = after.filter((p) => p.status === "pending");
    if (heldBack) fail(`${heldBack.message}\n  Everything before ${heldBack.version} is applied.`, 3);
    if (left.length && !ONLY?.length) fail(`${left.length} still pending: ${left.map((p) => p.version).join(", ")}`);
    say(left.length ? "\nDone (the rest were left out by --only)." : "\nDone: every migration is applied and verified.");
    for (const p of pending) {
      if (p.version === "0101") {
        say("\nAfter 0101: grant chat.manage at /admin/roles to any non-admin role that should run Chat");
        say("(0101 deliberately removes discord.manage without converting it; '*' admins already run Chat).");
      }
    }
  } finally {
    if (locked) await db.query(`select pg_advisory_unlock(hashtext('batch0:db-migrate'))`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => fail(describeError(err)));
