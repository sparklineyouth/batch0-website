/**
 * Onshape connection doctor: verify credentials and find the IDs that
 * scripts/mint-cards.mts needs.
 *
 * Read-only — it lists documents and inspects a Part Studio's configuration.
 * It never modifies your CAD.
 *
 * Usage:
 *   npm run onshape-doctor
 *   npm run onshape-doctor -- --doc <documentId>
 *   npm run onshape-doctor -- --test-export      # prove the STL pipe works
 *
 * With no --doc it lists your documents and their IDs. With --doc it drills
 * into that document: workspaces, tabs (elements), and the configuration
 * parameters of each Part Studio — which is exactly the set of values you
 * paste back into .env.local.
 *
 * --test-export exports the Part Studio named by .env.local (UNCONFIGURED) to
 * a temp file, purely to prove the export chain end-to-end: credentials ->
 * 307 redirect -> storage download -> bytes on disk. Worth having as its own
 * flag because that chain is the slow, failure-prone half of mint-cards, and
 * you want it verified BEFORE a 50-card run rather than discovering a 401 on
 * card 1 of 50.
 */

const BASE = "https://cad.onshape.com/api/v6";

function auth(): string {
  const access = process.env.ONSHAPE_ACCESS_KEY;
  const secret = process.env.ONSHAPE_SECRET_KEY;
  if (!access || !secret) {
    console.error(
      "Missing ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY.\n" +
        "Run with: node --env-file=.env.local scripts/onshape-doctor.mts",
    );
    process.exit(1);
  }
  return `Basic ${Buffer.from(`${access}:${secret}`).toString("base64")}`;
}

/**
 * Headers for following an Onshape export redirect.
 *
 * The STL endpoint answers 307 to a REGIONAL Onshape API host (e.g.
 * cad-usw2.onshape.com), not to a pre-signed storage URL — so the target still
 * demands credentials, and dropping the Authorization header there earns a
 * flat 401. (Onshape forum threads warn against re-sending auth on this
 * redirect; that advice does not match what the API actually does today.
 * Verified empirically via --test-export.)
 *
 * Credentials are attached ONLY for onshape.com hosts. `redirect: "manual"`
 * means we are hand-following a Location we did not choose, and blindly
 * replaying an API secret to whatever host it names is how credentials leak.
 * The suffix check uses a leading dot so "evil-onshape.com" cannot match.
 */
function redirectHeaders(location: string): Record<string, string> {
  const { host, protocol } = new URL(location);
  const isOnshape = host === "onshape.com" || host.endsWith(".onshape.com");
  if (!isOnshape || protocol !== "https:") {
    console.warn(`  ! not sending credentials to non-Onshape host: ${host}`);
    return {};
  }
  return { Authorization: auth() };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: auth(), Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status}\n${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const argv = process.argv.slice(2);
const docArg = argv.indexOf("--doc") >= 0 ? argv[argv.indexOf("--doc") + 1] : undefined;
const testExport = argv.includes("--test-export");

/**
 * Export the configured Part Studio as STL, unconfigured, to verify the pipe.
 *
 * Mirrors exportStl() in mint-cards.mts exactly. If this passes, minting's
 * export step is proven.
 */
async function runExportTest(): Promise<void> {
  const did = process.env.ONSHAPE_DOCUMENT_ID;
  const wid = process.env.ONSHAPE_WORKSPACE_ID;
  const eid = process.env.ONSHAPE_ELEMENT_ID;
  if (!did || !wid || !eid) {
    console.error("Set ONSHAPE_DOCUMENT_ID / _WORKSPACE_ID / _ELEMENT_ID in .env.local first.");
    process.exit(1);
  }

  const url =
    `${BASE}/partstudios/d/${did}/w/${wid}/e/${eid}/stl` +
    `?mode=binary&grouping=true&units=millimeter`;

  console.log("Exporting Part Studio as STL (no configuration)...");
  const res = await fetch(url, {
    headers: { Authorization: auth(), Accept: "application/vnd.onshape.v1+octet-stream" },
    redirect: "manual",
  });
  console.log(`  initial response: ${res.status}`);

  let bytes: Buffer;
  if (res.status === 307 || res.status === 302 || res.status === 301) {
    const location = res.headers.get("location");
    if (!location) throw new Error("redirect with no Location header");
    const host = new URL(location).host;
    console.log(`  -> ${res.status} to: ${host}`);
    const follow = await fetch(location, { headers: redirectHeaders(location) });
    console.log(`  -> download: ${follow.status}`);
    if (!follow.ok) throw new Error(`STL download -> ${follow.status}`);
    bytes = Buffer.from(await follow.arrayBuffer());
  } else {
    if (!res.ok) throw new Error(`STL export -> ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }

  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const out = join(tmpdir(), "onshape-export-test.stl");
  writeFileSync(out, bytes);

  // A binary STL is an 80-byte header + uint32 triangle count. Reading the
  // count back proves we got real geometry rather than an HTML error page that
  // happened to arrive with a 200.
  const triangles = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  console.log(`  wrote ${(bytes.length / 1024).toFixed(0)} KB, ${triangles} triangles`);
  unlinkSync(out);

  if (triangles === 0) {
    console.log("\n  ! 0 triangles — downloaded something, but it isn't geometry.");
    process.exit(1);
  }
  console.log("\nExport pipeline works. mint-cards will be able to download STLs.");
}

async function main() {
  if (testExport) {
    const me = await get<{ name?: string }>("/users/sessioninfo");
    console.log(`Authenticated as ${me.name ?? "?"}\n`);
    await runExportTest();
    return;
  }

  // sessioninfo is the cheapest proof the key pair is accepted at all, and it
  // separates "bad credentials" from "wrong document id" — two failures that
  // otherwise both surface as an opaque 404 later on.
  const me = await get<{ name?: string; email?: string }>("/users/sessioninfo");
  console.log(`Authenticated as ${me.name ?? "?"} <${me.email ?? "?"}>\n`);

  if (!docArg) {
    const docs = await get<{ items?: Array<{ name: string; id: string; defaultWorkspace?: { id: string } }> }>(
      "/documents?filter=0&limit=20",
    );
    const items = docs.items ?? [];
    if (!items.length) {
      console.log("No documents found.");
      return;
    }
    console.log("Your documents:\n");
    for (const d of items) {
      console.log(`  ${d.name}`);
      console.log(`    ONSHAPE_DOCUMENT_ID=${d.id}`);
      console.log(`    ONSHAPE_WORKSPACE_ID=${d.defaultWorkspace?.id ?? "(unknown)"}`);
      console.log("");
    }
    console.log("Re-run with --doc <ONSHAPE_DOCUMENT_ID> to inspect the card document.");
    return;
  }

  const doc = await get<{ name: string; defaultWorkspace?: { id: string } }>(`/documents/${docArg}`);
  const wid = doc.defaultWorkspace?.id;
  console.log(`Document: ${doc.name}`);
  console.log(`  ONSHAPE_DOCUMENT_ID=${docArg}`);
  console.log(`  ONSHAPE_WORKSPACE_ID=${wid ?? "(unknown)"}\n`);
  if (!wid) return;

  const elements = await get<Array<{ id: string; name: string; elementType: string }>>(
    `/documents/d/${docArg}/w/${wid}/elements`,
  );

  console.log("Tabs in this document:\n");
  for (const el of elements) {
    const isPartStudio = el.elementType === "PARTSTUDIO";
    console.log(`  ${el.name}  [${el.elementType}]`);
    if (!isPartStudio) {
      console.log("");
      continue;
    }
    console.log(`    ONSHAPE_ELEMENT_ID=${el.id}`);

    // The whole point of the doctor: show whether a string configuration input
    // exists yet. Without one, mint-cards has nothing to drive and would export
    // N identical cards.
    try {
      const cfg = await get<{
        configurationParameters?: Array<{ parameterId: string; parameterName?: string; type?: string }>;
      }>(`/elements/d/${docArg}/w/${wid}/e/${el.id}/configuration`);
      const params = cfg.configurationParameters ?? [];
      if (!params.length) {
        console.log("    configuration: NONE — add a string Configuration variable");
        console.log("                   named 'cardCode' and wire it into the Text sketch.");
      } else {
        console.log("    configuration parameters:");
        for (const p of params) {
          console.log(`      - ${p.parameterId}${p.parameterName ? `  ("${p.parameterName}")` : ""}`);
        }
        const wanted = process.env.ONSHAPE_CONFIG_PARAM || "cardCode";
        const found = params.some((p) => p.parameterId === wanted);
        console.log(
          found
            ? `    OK: "${wanted}" exists — ONSHAPE_CONFIG_PARAM=${wanted}`
            : `    NOTE: no parameter named "${wanted}". Set ONSHAPE_CONFIG_PARAM to one above, or rename it in Onshape.`,
        );
      }
    } catch (err) {
      console.log(`    configuration: could not read (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  console.error(
    "\nIf this is a 401: the key pair was rejected. If it's a 403: the key exists but\n" +
      "lacks the needed OAuth scopes — recreate it at cad.onshape.com/appstore/dev-portal\n" +
      "with at least Read/Write on documents.",
  );
  process.exit(1);
});
