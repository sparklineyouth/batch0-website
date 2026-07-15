/**
 * Mint a batch of founder pass cards: codes -> Supabase -> Onshape -> STLs.
 *
 * This is the whole pipeline. Run it, print what lands in out/, hand the cards
 * out. The website never talks to Onshape — a redeem page that depended on a
 * CAD API would be slow, rate-limited, and key-holding, and would buy nothing:
 * a card's geometry is frozen the moment it leaves the printer.
 *
 * Codes must be minted HERE, before printing, not chosen afterwards. The code
 * on the plastic and the hash in the database are set in the same run, so they
 * cannot disagree.
 *
 * For each card it:
 *   1. mints a random code (unambiguous alphabet — someone retypes this off
 *      a physical object, see MINT_ALPHABET)
 *   2. writes the peppered hash into founder_passes
 *   3. asks Onshape to encode { <configParam>: <code> } into a configuration
 *   4. exports that configuration of the Part Studio as an STL
 *   5. writes out/card-007.stl plus ONE local manifest.csv holding the
 *      plaintext codes — the only place they exist outside the plastic
 *
 * Usage (npm scripts wrap the --env-file and warning flags):
 *   npm run mint-cards -- --count 50 --start 1
 *   npm run mint-cards -- --count 2 --dry-run     # full preflight, writes nothing
 *   npm run mint-cards -- --count 50 --no-stl     # codes only, skip Onshape
 *   npm run onshape-doctor                        # verify creds, list document IDs
 *
 * Requires (from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOUNDER_PASS_PEPPER
 *   ONSHAPE_ACCESS_KEY, ONSHAPE_SECRET_KEY
 *   ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID, ONSHAPE_ELEMENT_ID
 *   ONSHAPE_CONFIG_PARAM   (optional, defaults to "cardCode")
 *
 * BEFORE this can work, the CAD has to cooperate — the API cannot author
 * geometry, only drive what you have already parameterised:
 *   - The Part Studio needs a configuration input of type "Configuration
 *     variable" with Type "Text", named to match ONSHAPE_CONFIG_PARAM.
 *   - The Text sketch that carries the code must be bound to it via
 *     "Configure text" in the Text dialog, so changing the configuration
 *     changes the geometry.
 *   - Sanity check by hand in Onshape first: flip the configuration and watch
 *     the text on the card change. If it does not move there, it will not move
 *     here, and this script will happily export 50 identical cards.
 * preflightConfigParam() below refuses to run until the parameter exists, but
 * it can only see that the input EXISTS — it cannot tell whether the sketch is
 * actually wired to it. That last check is yours, and it is the one that
 * silently ruins a print run.
 *
 * API keys: https://cad.onshape.com/appstore/dev-portal (max 2 active).
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nextBatchDefaults } from "../lib/founder-pass-batch.ts";
import {
  onshapeConfigFromEnv,
  preflightConfigParam,
  exportCardStl,
} from "../lib/onshape.ts";
import {
  hashPassCode,
  mintPassCode,
  normalizePassCode,
  requirePepper,
} from "../lib/founder-pass-code.ts";

function parseArgs(argv: string[]) {
  const flag = (n: string) => argv.includes(`--${n}`);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const startRaw = value("start");
  const batchRaw = value("batch");
  return {
    count: Number.parseInt(value("count") ?? "0", 10),
    // undefined => derive from the database. Making the caller compute the
    // next serial was a mistake: the DB already knows, and getting it wrong
    // fails AFTER the Onshape preflight with a unique-violation that reads
    // like a bug in the script rather than "you wanted --start, not --count".
    start: startRaw === undefined ? undefined : Number.parseInt(startRaw, 10),
    batch: batchRaw,
    outDir: value("out") ?? "out",
    dryRun: flag("dry-run"),
    noStl: flag("no-stl"),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run with: node --env-file=.env.local scripts/mint-cards.mts ...`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { count, outDir, dryRun, noStl } = args;

  if (!Number.isInteger(count) || count < 1) {
    console.error(
      "usage: npm run mint-cards -- --count N [--start N] [--batch NAME] [--dry-run] [--no-stl]\n" +
        "\n" +
        "  --count N   how many cards to mint (required)\n" +
        "  --start N   first serial. Defaults to the next unused serial, read\n" +
        "              from the database — you should not normally pass this.\n" +
        "  --batch     batch name. Defaults to the next cards-NN.\n",
    );
    process.exit(1);
  }

  const pepper = requirePepper();
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const onshape = onshapeConfigFromEnv();
  if (!onshape && !noStl) {
    console.error(
      "Onshape is not configured (need ONSHAPE_ACCESS_KEY, ONSHAPE_SECRET_KEY,\n" +
        "ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID, ONSHAPE_ELEMENT_ID).\n" +
        "Run `npm run onshape-doctor` to find the IDs, or pass --no-stl to mint codes only.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve serial/batch from the DB BEFORE the slow Onshape preflight, so a
  // collision surfaces in a second rather than after minutes of CAD work.
  const defaults = await nextBatchDefaults(supabase);
  const start = args.start ?? defaults.start;
  const batch = args.batch ?? defaults.batch;

  if (args.start !== undefined && args.start < defaults.start) {
    console.error(
      `--start ${args.start} would collide: serial ${defaults.start - 1} already exists.\n` +
        `Next free serial is ${defaults.start}. Omit --start to use it automatically.`,
    );
    process.exit(1);
  }

  console.log(
    `Minting ${count} card(s): serials ${start}-${start + count - 1}, batch "${batch}".` +
      (args.start === undefined ? "  (serial auto-detected from database)" : ""),
  );

  if (!noStl) {
    console.log(`Checking Onshape configuration parameter "${onshape!.configParam}"...`);
    await preflightConfigParam(onshape!);
    console.log("  ok — parameter exists.\n");
  }

  // Mint everything up front so a mid-run Onshape failure cannot leave the
  // database holding hashes for cards whose STL never got exported.
  const cards = Array.from({ length: count }, (_, i) => ({
    serial: start + i,
    code: normalizePassCode(mintPassCode()),
  }));

  if (dryRun) {
    console.log(`--dry-run: nothing written to Supabase, Onshape, or disk.`);
    return;
  }

  mkdirSync(outDir, { recursive: true });

  const manifest = join(outDir, "manifest.csv");
  if (!existsSync(manifest)) {
    writeFileSync(manifest, "serial,code,batch\n");
  }

  // Supabase first. If this fails we have printed nothing and lost nothing;
  // if it succeeded and the STL export later dies, the cards simply are not
  // printed yet and the rows sit unredeemed until they are.
  const { error } = await supabase.from("founder_passes").insert(
    cards.map((c) => ({
      serial: c.serial,
      code_hash: hashPassCode(c.code, pepper),
      batch,
    })),
  );
  if (error) {
    console.error(`\nSupabase insert failed: ${error.message}`);
    if (/duplicate key/i.test(error.message)) {
      console.error(
        `Serials ${start}-${start + count - 1} overlap an existing batch. This should not happen —\n` +
          `the serial is auto-detected from the database. Did you pass --start by hand?`,
      );
    }
    process.exit(1);
  }
  console.log(`Wrote ${cards.length} pass row(s) to Supabase (batch "${batch}").`);

  // The manifest is the ONLY plaintext record. Written immediately after the
  // DB insert and before the slow part, so a crash during STL export cannot
  // orphan a live pass whose code nobody knows.
  for (const c of cards) {
    appendFileSync(manifest, `${c.serial},${c.code},${batch}\n`);
  }
  console.log(`Wrote plaintext codes to ${manifest} — keep this offline.`);

  if (noStl) {
    console.log("--no-stl: skipping Onshape export.");
    return;
  }

  for (const c of cards) {
    const label = `#${String(c.serial).padStart(3, "0")}`;
    process.stdout.write(`  ${label} exporting...`);
    const stl = await exportCardStl(onshape!, c.code);

    const file = join(outDir, `card-${String(c.serial).padStart(3, "0")}.stl`);
    writeFileSync(file, stl);
    console.log(` ${(stl.length / 1024).toFixed(0)} KB -> ${file}`);
  }

  console.log(`\nDone. ${cards.length} STL(s) in ${outDir}/. Print them, then hand them out.`);
  console.log("The database holds only peppered hashes — manifest.csv is your only code list.");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
