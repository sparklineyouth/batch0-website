/**
 * seo-doctor — catches the class of bug that cost us a search snippet.
 *
 *   npm run seo-doctor            # check production
 *   npm run seo-doctor -- --url=http://localhost:3000
 *
 * Background: the cohort dates live in a Supabase row that admins move
 * without a deploy. Twice, a hardcoded copy of those dates in
 * `app/layout.tsx` was left behind, and production served Google
 * "Cohort 1 runs Jul 30–Sep 13" while the page body said Sep 14 — i.e. the
 * search result told every prospective student the cohort was already over.
 *
 * The metadata is generated per request now, so that specific bug is fixed
 * structurally. This script guards the two things that can still rot:
 *
 *   1. FALLBACK_COHORT drifting from the real row (only visible during a
 *      Supabase outage — exactly when nobody is watching).
 *   2. Production serving an older build than the repo believes, or a
 *      description Google will truncate.
 *
 * Exits non-zero on FAIL so it can be wired into CI or a scheduled job.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  META_DESCRIPTION_MAX,
  TITLE_TAG_MAX,
  blogTitleTag,
  buildMetaDescription,
  formatApplyBy,
  formatDateSentence,
  pickRelated,
} from "../lib/seo-meta.ts";
import {
  PROMO_ENDS_AT,
  PROMO_PERCENT,
  PROMO_SALE_PRICE_CENTS,
  activePromo,
  resolvePromoConfig,
  isDefaultPromoConfig,
  listPriceCents,
} from "../lib/promo.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const SITE = (arg("url") ?? "https://batch0.org").replace(/\/$/, "");

let failures = 0;
let warnings = 0;

const pass = (msg: string) => console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
const warn = (msg: string) => {
  warnings++;
  console.log(`  \x1b[33mWARN\x1b[0m  ${msg}`);
};
const fail = (msg: string) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
};
const skip = (msg: string) => console.log(`  \x1b[90mSKIP\x1b[0m  ${msg}`);
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

// ---------------------------------------------------------------------------
// Read FALLBACK_COHORT out of the source.
//
// Parsed as text rather than imported: lib/site-config.ts uses "@/" path
// aliases and pulls in the Supabase server client, neither of which resolve
// under a bare `node` run. Text-extraction keeps this script dependency-free
// and means it checks exactly what a reviewer would read in the diff.
// ---------------------------------------------------------------------------
type FallbackFields = {
  startsOn: string | null;
  endsOn: string | null;
  applicationsCloseAt: string | null;
  capacity: number | null;
  priceCents: number | null;
};

async function readFallbackCohort(): Promise<FallbackFields | null> {
  const src = await readFile(path.join(ROOT, "lib/site-config.ts"), "utf8");
  const block = src.match(
    /export const FALLBACK_COHORT:\s*ActiveCohort\s*=\s*\{([\s\S]*?)\n\};/,
  )?.[1];
  if (!block) return null;

  const str = (key: string) => {
    const m = block.match(new RegExp(`${key}:\\s*(?:"([^"]*)"|null)`));
    return m ? (m[1] ?? null) : null;
  };
  const num = (key: string) => {
    const m = block.match(new RegExp(`${key}:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  return {
    startsOn: str("startsOn"),
    endsOn: str("endsOn"),
    applicationsCloseAt: str("applicationsCloseAt"),
    capacity: num("capacity"),
    priceCents: num("priceCents"),
  };
}

// ---------------------------------------------------------------------------
// 1. FALLBACK_COHORT vs the live cohort row.
// ---------------------------------------------------------------------------
async function checkFallbackDrift(fallback: FallbackFields) {
  section("1. Outage fallback vs the real cohort row");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || url.includes("YOUR_PROJECT")) {
    skip("No Supabase credentials in env — cannot diff FALLBACK_COHORT.");
    skip("Run with real .env.local to enable this check.");
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: pin } = await db
    .from("site_settings")
    .select("value")
    .eq("key", "active_cohort_id")
    .maybeSingle();

  let row: any = null;
  if (typeof pin?.value === "string") {
    ({ data: row } = await db
      .from("cohorts")
      .select("*")
      .eq("id", pin.value)
      .maybeSingle());
  }
  if (!row) {
    ({ data: row } = await db
      .from("cohorts")
      .select("*")
      .in("status", ["upcoming", "active"])
      .order("starts_on", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle());
  }

  if (!row) {
    warn("No upcoming/active cohort row found — the site is running on FALLBACK_COHORT.");
    return;
  }

  const comparisons: Array<[string, unknown, unknown]> = [
    ["startsOn", fallback.startsOn, row.starts_on],
    ["endsOn", fallback.endsOn, row.ends_on],
    ["capacity", fallback.capacity, row.capacity],
    ["priceCents", fallback.priceCents, row.price_cents],
  ];

  for (const [field, local, live] of comparisons) {
    if (String(local) === String(live)) pass(`${field} matches (${String(live)})`);
    else fail(`${field} drifted — FALLBACK_COHORT has ${String(local)}, DB has ${String(live)}`);
  }

  // Timestamps compared as instants, not strings: "+00:00" and "Z" are the
  // same moment and shouldn't trip the check.
  const localClose = fallback.applicationsCloseAt
    ? new Date(fallback.applicationsCloseAt).getTime()
    : null;
  const liveClose = row.applications_close_at
    ? new Date(row.applications_close_at).getTime()
    : null;
  if (localClose === liveClose) pass("applicationsCloseAt matches");
  else
    fail(
      `applicationsCloseAt drifted — FALLBACK_COHORT has ${fallback.applicationsCloseAt}, DB has ${row.applications_close_at}`,
    );

  if (liveClose !== null && liveClose < Date.now()) {
    warn("The application deadline has passed. Snippets will stop advertising it.");
  }
}


// ---------------------------------------------------------------------------
// The promotion: is the sale the code believes in actually running?
// ---------------------------------------------------------------------------
//
// This is the check the previous promo run did not have, and the one failure it
// could not have caught. `lib/promo.ts` holds the SEED promo; `site_settings`
// holds the admin override, and the override WINS. So the repo can ship with a
// live 10%-off seed while the site still charges full price, because a
// `promo_enabled: false` row left over from the last run silently beats it.
// Nothing looks broken in that state — there is simply no sale, which from the
// outside is indistinguishable from never having deployed.
//
// It also checks the thing that separates a real sale from a cosmetic one:
// that every cohort being sold has a `price_cents` the discount can reach.
async function checkPromo() {
  section("2. The tuition promotion");

  const seed = activePromo(new Date());
  if (seed) {
    pass(
      `Seed promo in lib/promo.ts is live: ${PROMO_PERCENT}% off until ${seed.longDeadline} (${PROMO_ENDS_AT}).`,
    );
  } else {
    warn(
      `Seed promo in lib/promo.ts has EXPIRED (${PROMO_ENDS_AT}) — only an admin-set promo can be running.`,
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || url.includes("YOUR_PROJECT")) {
    skip("No Supabase credentials in env — cannot read the admin-set promo.");
    skip("Run with real .env.local to confirm the sale is actually live.");
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: rows, error } = await db
    .from("site_settings")
    .select("key, value")
    .in("key", ["promo_enabled", "promo_percent", "promo_ends_at"]);
  if (error) {
    fail(`Could not read promo_* from site_settings: ${error.message}`);
    return;
  }

  const raw: Record<string, unknown> = {};
  for (const r of rows ?? []) raw[r.key] = r.value;
  const config = resolvePromoConfig(raw);
  const live = activePromo(new Date(), config);

  if ((rows ?? []).length === 0) {
    pass("No promo_* rows in site_settings — the site runs on the seed above.");
  } else if (isDefaultPromoConfig(config)) {
    pass("site_settings promo matches the seed exactly.");
  } else {
    const found = (rows ?? [])
      .map((r) => `${r.key}=${JSON.stringify(r.value)}`)
      .join(", ");
    warn(`site_settings OVERRIDES the seed: ${found}`);
  }

  if (live) {
    pass(
      `Live promo: ${live.percent}% off${live.longDeadline ? ` until ${live.longDeadline}` : " (open-ended)"}.`,
    );
    if (config.endsAt) {
      const hoursLeft =
        (new Date(config.endsAt).getTime() - Date.now()) / 3_600_000;
      if (hoursLeft < 48) {
        warn(
          `Only ${hoursLeft.toFixed(1)}h left on the promo — every surface stops advertising it at the deadline.`,
        );
      }
    }
  } else if (seed) {
    // The exact silent failure this section exists for.
    fail(
      "NO PROMO IS RUNNING even though the seed says one should be. A row in " +
        "site_settings is overriding it — turn it on at /admin/pricing " +
        "(\"Promotion active\" + \"Discount %\"), or the sale stays invisible.",
    );
  } else {
    pass("No promo running and the seed agrees — tuition shows list price.");
  }

  // A sale nobody can receive. `promoPriceCents` refuses to discount a base at
  // or below PROMO_SALE_PRICE_CENTS (the $78 artifact), so a cohort priced at
  // or under that floor quietly charges list while the site advertises a
  // discount. Checked for EVERY cohort on sale, not just the active one: the
  // promo is site-wide, and winter is sold alongside fall.
  if (!live) return;
  const { data: cohorts } = await db
    .from("cohorts")
    .select("name, status, price_cents")
    .in("status", ["upcoming", "active"]);
  for (const c of cohorts ?? []) {
    const listCents = listPriceCents(c.price_cents);
    if (listCents <= PROMO_SALE_PRICE_CENTS) {
      fail(
        `Cohort "${c.name}" holds ${c.price_cents} cents, at or below the ` +
          `${PROMO_SALE_PRICE_CENTS}-cent double-discount floor — it will NOT receive the promo, ` +
          `so the site advertises a discount this cohort never gets.`,
      );
    } else if (listCents !== c.price_cents) {
      warn(
        `Cohort "${c.name}" holds ${c.price_cents} cents, read as list price ${listCents} by ` +
          `listPriceCents(). Set it to ${listCents} in /admin/cohorts to retire that repair.`,
      );
    } else {
      pass(`Cohort "${c.name}" (${c.status}) at ${listCents} cents receives the promo.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3 & 4. What the deployed site is actually telling search engines.
// ---------------------------------------------------------------------------
function extractMeta(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, "i"),
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

async function checkLiveMeta(fallback: FallbackFields) {
  section(`3. Live meta descriptions on ${SITE}`);

  const expected = buildMetaDescription({
    cohortLabel: "Cohort 1",
    startsOn: fallback.startsOn,
    endsOn: fallback.endsOn,
    applicationsCloseAt: fallback.applicationsCloseAt,
    basePriceLabel: `$${Math.round((fallback.priceCents ?? 0) / 100)}`,
  });

  for (const route of ["/", "/program"]) {
    let html: string;
    try {
      const res = await fetch(`${SITE}${route}`, {
        headers: { "user-agent": "batch0-seo-doctor" },
      });
      if (!res.ok) {
        fail(`${route} returned HTTP ${res.status}`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      fail(`${route} unreachable: ${(err as Error).message}`);
      continue;
    }

    const description = extractMeta(html, "description");
    if (!description) {
      fail(`${route} has no meta description at all`);
      continue;
    }

    console.log(`  \x1b[90m${route} → "${description}"\x1b[0m`);

    if (description.length > META_DESCRIPTION_MAX) {
      fail(
        `${route} description is ${description.length} chars (budget ${META_DESCRIPTION_MAX}) — Google will truncate it`,
      );
    } else {
      pass(`${route} description fits the ${META_DESCRIPTION_MAX}-char budget`);
    }

    // The bug that started all this: a date in the snippet that no longer
    // matches the cohort. Any date-like token must correspond to the real row.
    const dates = description.match(/[A-Z][a-z]{2}\s+\d{1,2}/g) ?? [];
    const legit = [
      formatDateSentence(fallback.startsOn, fallback.endsOn),
      formatDateSentence(fallback.startsOn, fallback.endsOn, { year: false }),
      formatApplyBy(fallback.applicationsCloseAt),
    ].join(" ");
    const stale = dates.filter((d) => !legit.includes(d));
    if (stale.length) {
      fail(
        `${route} advertises date(s) [${stale.join(", ")}] that aren't in the current cohort (${legit.trim()}). Production is likely serving an older build.`,
      );
    } else if (dates.length) {
      pass(`${route} dates match the current cohort`);
    } else {
      pass(`${route} carries no hardcoded dates`);
    }

    if (route === "/" && description !== expected) {
      warn(`/ description differs from what this checkout would render.`);
      warn(`  expected: "${expected}"`);
    }

    if (/U\.?S\.?\s+high schoolers/i.test(description)) {
      warn(
        `${route} says "U.S. high schoolers" but the FAQ and regional pricing say students can join from anywhere.`,
      );
    }

    // Crawl paths into the blog. The homepage holds the most authority on the
    // site and for a long time passed none of it on — it linked to zero posts,
    // which is a large part of why most of the 135 guides aren't indexed.
    if (route === "/") {
      const postLinks = new Set(
        [...html.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1]),
      );
      postLinks.delete("category");
      const hubLinks = new Set(
        [...html.matchAll(/href="\/blog\/category\/([a-z0-9-]+)"/g)].map((m) => m[1]),
      );

      if (postLinks.size === 0) {
        fail("homepage links to 0 blog posts — the blog gets no authority from it");
      } else {
        pass(`homepage links to ${postLinks.size} blog posts`);
      }
      if (hubLinks.size === 0) {
        fail("homepage links to 0 category hubs");
      } else {
        pass(`homepage links to ${hubLinks.size} category hubs`);
      }
    }
  }
}

async function checkCrawlerFiles() {
  section("4. Crawler entry points");
  for (const file of ["/robots.txt", "/sitemap.xml"]) {
    try {
      const res = await fetch(`${SITE}${file}`);
      if (!res.ok) {
        fail(`${file} returned HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      if (file === "/sitemap.xml") {
        const count = (body.match(/<loc>/g) ?? []).length;
        if (count === 0) fail("sitemap.xml contains no <loc> entries");
        else pass(`sitemap.xml lists ${count} URLs`);

        const disallowed = ["/apply", "/dashboard", "/admin"].filter((p) =>
          body.includes(`<loc>${SITE}${p}</loc>`),
        );
        if (disallowed.length)
          fail(`sitemap lists robots-disallowed routes: ${disallowed.join(", ")}`);
        else pass("sitemap lists no robots-disallowed routes");
      } else {
        if (!body.includes("Sitemap:")) fail("robots.txt does not reference the sitemap");
        else pass("robots.txt references the sitemap");
      }
    } catch (err) {
      fail(`${file} unreachable: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The blog catalogue.
//
// 135 posts is far too many to eyeball, and the two failure modes here are
// silent: a title or description that's a few characters over budget looks
// fine in the editor and gets truncated in the only place that matters.
// ---------------------------------------------------------------------------
type PostFrontmatter = {
  slug: string;
  title: string;
  seoTitle?: string;
  description: string;
  category: string;
  tags: string[];
};

function parseFrontmatter(slug: string, raw: string): PostFrontmatter | null {
  const fm = raw.split("---")[1];
  if (!fm) return null;
  const field = (key: string) => {
    const m = fm.match(new RegExp(`^${key}: *(.*)$`, "m"));
    return m ? m[1].trim().replace(/^"|"$/g, "") : "";
  };
  const tagsRaw = fm.match(/^tags: *\[(.*)\]/m)?.[1] ?? "";
  return {
    slug,
    title: field("title"),
    seoTitle: field("seoTitle") || undefined,
    description: field("description"),
    category: field("category"),
    tags: tagsRaw
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  };
}

async function checkBlog() {
  section("5. Blog catalogue");

  let files: string[];
  try {
    files = (await readdir(path.join(ROOT, "content/blog"))).filter((f) =>
      f.endsWith(".md"),
    );
  } catch {
    skip("content/blog not found");
    return;
  }

  const posts: PostFrontmatter[] = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const raw = await readFile(path.join(ROOT, "content/blog", file), "utf8");
    const parsed = parseFrontmatter(slug, raw);
    if (!parsed) {
      fail(`${slug}: could not parse frontmatter`);
      continue;
    }
    posts.push(parsed);
  }

  const longTitles = posts.filter(
    (p) => blogTitleTag(p.title, p.seoTitle).length > TITLE_TAG_MAX,
  );
  const longDescs = posts.filter((p) => p.description.length > META_DESCRIPTION_MAX);
  const noDesc = posts.filter((p) => !p.description);

  if (longTitles.length) {
    fail(
      `${longTitles.length} post(s) exceed the ${TITLE_TAG_MAX}-char title budget even unbranded — add a shorter \`seoTitle\` to each:`,
    );
    longTitles
      .slice(0, 10)
      .forEach((p) =>
        console.log(
          `          ${blogTitleTag(p.title, p.seoTitle).length}  ${p.slug}`,
        ),
      );
  } else {
    pass(`all ${posts.length} post titles fit the ${TITLE_TAG_MAX}-char budget`);
  }

  if (longDescs.length) {
    fail(`${longDescs.length} post description(s) exceed ${META_DESCRIPTION_MAX} chars:`);
    longDescs
      .slice(0, 10)
      .forEach((p) => console.log(`          ${p.description.length}  ${p.slug}`));
  } else {
    pass(`all ${posts.length} post descriptions fit the budget`);
  }

  if (noDesc.length) fail(`${noDesc.length} post(s) have no description`);

  // Internal-link orphans. Every post ships three "Keep reading" links, so
  // there are 3 × N link slots; a post that appears in none of them can only
  // be reached from the index and its category hub. Under the old
  // "same category, then most recent" rule that was the overwhelming
  // majority of the catalogue, because every post linked the same few
  // recent siblings.
  const linkedTo = new Set<string>();
  for (const p of posts) {
    for (const r of pickRelated(p, posts, 3)) linkedTo.add(r.slug);
  }
  const orphans = posts.filter((p) => !linkedTo.has(p.slug));
  const reach = (((posts.length - orphans.length) / posts.length) * 100).toFixed(0);

  if (orphans.length > posts.length * 0.5) {
    fail(
      `${orphans.length}/${posts.length} posts receive no "Keep reading" link (${reach}% reachable)`,
    );
  } else if (orphans.length) {
    warn(
      `${orphans.length}/${posts.length} posts receive no "Keep reading" link (${reach}% reachable)`,
    );
  } else {
    pass(`every post is linked from at least one other post`);
  }

  const cats = new Map<string, number>();
  for (const p of posts) cats.set(p.category, (cats.get(p.category) ?? 0) + 1);
  pass(
    `categories: ${[...cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} (${n})`)
      .join(", ")}`,
  );

  // The hub pages carry hand-written copy, which is exactly the kind of thing
  // that drifts a character over budget and nobody notices. Same rule as the
  // posts, checked from the same place.
  const shared = await readFile(path.join(ROOT, "lib/blog-shared.ts"), "utf8");
  const hubDescriptions = [...shared.matchAll(/description:\s*\n?\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const overBudgetHubs = hubDescriptions.filter(
    (d) => d.length > META_DESCRIPTION_MAX,
  );
  if (!hubDescriptions.length) {
    warn("could not read category hub descriptions from lib/blog-shared.ts");
  } else if (overBudgetHubs.length) {
    fail(
      `${overBudgetHubs.length} category hub description(s) exceed ${META_DESCRIPTION_MAX} chars:`,
    );
    overBudgetHubs.forEach((d) =>
      console.log(`          ${d.length}  "${d.slice(0, 60)}…"`),
    );
  } else {
    pass(`all ${hubDescriptions.length} category hub descriptions fit the budget`);
  }

  // Every category must have copy, or the hub renders with an empty <h1>.
  const missingCopy = [...cats.keys()].filter(
    (c) => !new RegExp(`^\\s*${c}:\\s*\\{`, "m").test(shared),
  );
  if (missingCopy.length) {
    fail(`no CATEGORY_COPY entry for: ${missingCopy.join(", ")}`);
  } else {
    pass("every category has hub copy");
  }
}

// ---------------------------------------------------------------------------

console.log(`\n\x1b[1mbatch0 seo-doctor\x1b[0m  →  ${SITE}`);

const fallback = await readFallbackCohort();
if (!fallback) {
  console.log("\n  \x1b[31mFAIL\x1b[0m  Could not parse FALLBACK_COHORT from lib/site-config.ts");
  process.exit(1);
}

await checkFallbackDrift(fallback);
await checkPromo();
await checkLiveMeta(fallback);
await checkCrawlerFiles();
await checkBlog();

console.log(
  `\n${failures ? "\x1b[31m" : "\x1b[32m"}${failures} failure(s)\x1b[0m, ${warnings} warning(s)\n`,
);
process.exit(failures > 0 ? 1 : 0);
