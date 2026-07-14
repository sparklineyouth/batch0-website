import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fonts for the dynamically generated OG images.
 *
 * Satori (behind next/og) can't use the CSS-loaded webfonts the site itself
 * ships — it needs the raw binary, and it does NOT read woff2, so these are
 * TTFs.
 *
 * Read off disk rather than via the `fetch(new URL(..., import.meta.url))`
 * pattern from the Next docs: that resolves to a file:// URL here, and Node's
 * fetch refuses file://, which fails every one of these routes at build time
 * (they all run `runtime = "nodejs"`). next.config.js has a matching
 * outputFileTracingIncludes entry so the .ttf files follow the routes into
 * the serverless bundle — without it this works locally and 500s in prod.
 *
 * Loaded once per lambda and memoised; without the cache every OG request
 * re-reads ~430KB of font data.
 */
type Font = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: "normal";
};

let cache: Font[] | null = null;

export async function ogFonts(): Promise<Font[]> {
  if (cache) return cache;

  const read = async (f: string) => {
    const buf = await readFile(join(process.cwd(), "lib/og-fonts", f));
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  };

  const [vt323, mono, monoSemi] = await Promise.all([
    read("VT323-Regular.ttf"),
    read("IBMPlexMono-Regular.ttf"),
    read("IBMPlexMono-SemiBold.ttf"),
  ]);

  cache = [
    { name: "VT323", data: vt323, weight: 400, style: "normal" },
    { name: "IBM Plex Mono", data: mono, weight: 400, style: "normal" },
    { name: "IBM Plex Mono", data: monoSemi, weight: 600, style: "normal" },
  ];
  return cache;
}

/** Font-family stacks matching the site's type system. */
export const OG_DISPLAY = "VT323";
export const OG_BODY = "IBM Plex Mono";
