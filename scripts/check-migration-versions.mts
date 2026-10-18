/**
 * Fails when a migration file this pull request adds takes a version that
 * main, or another open pull request, already holds under another name.
 * Read-only: it reads GitHub's API and touches no database.
 *
 *   GH_TOKEN=$(gh auth token) npm run check:migration-versions -- --pr 345
 *
 * CI runs it on every pull request (the "Migration versions" step), with the
 * workflow's own read-only token. Flags: --pr N (default: the pull request
 * the workflow runs for), --repo owner/name (default: GITHUB_REPOSITORY, else
 * the origin remote).
 *
 * Why: `npm test` fails when two files in one checkout share a version, but
 * a pull request's checks run once, against main as it was then. Two
 * branches that each take the next free number (how 0071 came to be shared)
 * both pass, both merge, and on the second merge Supabase's GitHub
 * integration fails that file's history INSERT and rolls it back, so its
 * schema never reaches production while Vercel deploys its code
 * (docs/migrations-2026-10.md, "Versions"). Comparing with the other open
 * pull requests catches the pair while both are open: whichever runs this
 * second fails. The API is read when the step runs, so re-running the CI
 * job re-checks against main and the open pull requests as they are then.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { addedMigrationFiles, parseMigrationFile, versionConflicts, type VersionClaim } from "../lib/migration-plan.ts";

/** The branch Supabase's integration deploys from. */
const MAIN = "main";

const argv = process.argv.slice(2);
function option(name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

function quit(message: string, code: number): never {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function repository(): string {
  const named = option("repo") ?? process.env.GITHUB_REPOSITORY;
  if (named) return named;
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(origin.stdout ?? "");
  if (m) return m[1];
  return quit("Which repository? Pass --repo owner/name.", 2);
}

function pullRequest(): number {
  const named = option("pr");
  if (named) return Number(named);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: number } };
    if (event.pull_request?.number) return event.pull_request.number;
  }
  return quit("Which pull request? Pass --pr N (CI runs this only for pull requests).", 2);
}

function token(): string {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim();
  return quit("No GitHub token: set GH_TOKEN (e.g. GH_TOKEN=$(gh auth token)).", 2);
}

const REPO = repository();
const PR = pullRequest();
const TOKEN = token();

async function api<T>(route: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "batch0-check-migration-versions",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Every page of a list endpoint. */
async function all<T>(route: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<T[]>(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

type PrFile = { filename: string; status: string };
type Pull = { number: number; title: string };

async function main(): Promise<void> {
  const added = addedMigrationFiles(await all<PrFile>(`/pulls/${PR}/files`));
  const onMain = (await api<{ name: string; type: string }[]>(`/contents/supabase/migrations?ref=${MAIN}`))
    .filter((e) => e.type === "file")
    .map((e) => e.name);
  const claims: VersionClaim[] = onMain.map((file) => ({ file, where: MAIN }));
  const open = (await all<Pull>(`/pulls?state=open`)).filter((p) => p.number !== PR);
  for (const p of open) {
    for (const file of addedMigrationFiles(await all<PrFile>(`/pulls/${p.number}/files`))) {
      claims.push({ file, where: `#${p.number} (${p.title})` });
    }
  }

  const held = [...claims.map((c) => c.file), ...added].map((f) => parseMigrationFile(f, "")?.num ?? 0);
  const next = String(Math.max(0, ...held) + 1).padStart(4, "0");
  const elsewhere = claims.filter((c) => c.where !== MAIN).map((c) => `${c.file} ${c.where.split(" ")[0]}`);
  console.log(`#${PR} adds: ${added.length ? added.join(", ") : "no migration files"}`);
  console.log(`Open pull requests add: ${elsewhere.length ? elsewhere.join(", ") : "none"}`);

  const conflicts = versionConflicts(added, claims);
  if (conflicts.length) {
    for (const c of conflicts) console.error(`✗ ${c.file}: version ${c.version} is already ${c.claimedBy.file} on ${c.claimedBy.where}`);
    quit(
      `Two files on one version can't both be recorded by Supabase (docs/migrations-2026-10.md, "Versions").\n` +
        `  Rename this pull request's file to the next number nobody holds: ${next}.`,
      1,
    );
  }
  console.log(`✓ No other file holds ${added.length ? "these versions" : "a version this adds"}. Next free number: ${next}.`);
}

main().catch((err) => quit(err instanceof Error ? err.message : String(err), 1));
