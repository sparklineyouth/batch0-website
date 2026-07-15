import { NextResponse, type NextRequest } from "next/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  hashPassCode,
  mintPassCode,
  normalizePassCode,
  requirePepper,
} from "@/lib/founder-pass-code";
import {
  onshapeConfigFromEnv,
  preflightConfigParam,
  exportCardStl,
} from "@/lib/onshape";
import { nextBatchDefaults } from "@/lib/founder-pass-batch";
import { ZipStream } from "@/lib/zip";

// Onshape exports run ~1-2s each, so 50 cards lands near 100s. The platform
// ceiling is 300s; this asks for it explicitly rather than inheriting a shorter
// default and dying mid-batch.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Above ~50 the Onshape leg risks the function timeout, and a timeout AFTER the
// database insert is the one failure that orphans live passes whose codes exist
// nowhere. Refuse rather than gamble; mint two batches instead.
const MAX_PER_REQUEST = 50;

/**
 * Mint a batch of founder passes and stream back a ZIP of STLs + the manifest.
 *
 * Ordering is the whole design here. Codes are minted, then EVERY STL is
 * exported into memory, and only then is anything written to the database:
 *
 *   mint -> export all -> insert -> stream
 *
 * The tempting order (insert, then export-and-stream as you go) is wrong. A
 * failure on card 37 would leave 50 rows in founder_passes whose plaintext
 * codes exist only in a half-written download — passes that are live, that
 * nobody can ever redeem, and that permanently consume their serials. Since the
 * database stores peppered hashes only, those codes are unrecoverable. Holding
 * ~30MB in memory is a cheap price for making the failure mode "nothing
 * happened".
 *
 * The response streams because a Vercel function's buffered response body caps
 * out around 4.5MB and a 50-card zip is ~30MB.
 */
export async function POST(request: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") {
    return NextResponse.json({ error: "Not authorised." }, { status: 403 });
  }

  const count = Number.parseInt(
    request.nextUrl.searchParams.get("count") ?? "0",
    10,
  );
  if (!Number.isInteger(count) || count < 1 || count > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `count must be between 1 and ${MAX_PER_REQUEST}.` },
      { status: 400 },
    );
  }

  const onshape = onshapeConfigFromEnv();
  if (!onshape) {
    return NextResponse.json(
      {
        error:
          "Onshape isn't configured in this environment. Set ONSHAPE_ACCESS_KEY, " +
          "ONSHAPE_SECRET_KEY, ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID and " +
          "ONSHAPE_ELEMENT_ID, or mint locally with: npm run mint-cards -- --count " +
          count,
      },
      { status: 501 },
    );
  }

  let pepper: string;
  try {
    pepper = requirePepper();
  } catch {
    return NextResponse.json(
      { error: "FOUNDER_PASS_PEPPER isn't set in this environment." },
      { status: 501 },
    );
  }

  const admin = createAdminClient();

  try {
    // Proves the config input exists before we mint anything. It cannot prove
    // the Text sketch is bound to it — only looking at the geometry can.
    await preflightConfigParam(onshape);

    const { start, batch } = await nextBatchDefaults(admin);

    const cards = Array.from({ length: count }, (_, i) => ({
      serial: start + i,
      code: normalizePassCode(mintPassCode()),
    }));

    // --- Export everything BEFORE writing a single row. See the note above.
    const stls: Buffer[] = [];
    for (const card of cards) {
      stls.push(await exportCardStl(onshape, card.code));
    }

    const { error } = await admin.from("founder_passes").insert(
      cards.map((c) => ({
        serial: c.serial,
        code_hash: hashPassCode(c.code, pepper),
        batch,
      })),
    );
    if (error) {
      return NextResponse.json(
        { error: `Database insert failed: ${error.message}` },
        { status: 500 },
      );
    }

    // --- Everything below is committed; stream the archive.
    const zip = new ZipStream();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // manifest.csv first: it is the ONLY copy of the plaintext codes
        // outside the plastic. The database holds peppered hashes, so if this
        // download is lost the batch is unmintable-again and unusable.
        const manifest =
          "serial,code,batch\n" +
          cards.map((c) => `${c.serial},${c.code},${batch}`).join("\n") +
          "\n";
        controller.enqueue(zip.addFile("manifest.csv", Buffer.from(manifest, "utf8")));

        cards.forEach((card, i) => {
          const name = `card-${String(card.serial).padStart(3, "0")}.stl`;
          controller.enqueue(zip.addFile(name, stls[i]));
        });

        controller.enqueue(zip.finish());
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${batch}.zip"`,
        // The archive holds live card codes. Keep it out of any cache between
        // here and the browser.
        "Cache-Control": "no-store, private",
        "X-Pass-Batch": batch,
        "X-Pass-Serials": `${start}-${start + count - 1}`,
      },
    });
  } catch (err) {
    // Reached only if minting/exporting threw, i.e. before the insert — so
    // nothing was written and retrying is safe.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[founder-pass] mint failed", err);
    return NextResponse.json(
      { error: message, note: "Nothing was written — safe to retry." },
      { status: 500 },
    );
  }
}
