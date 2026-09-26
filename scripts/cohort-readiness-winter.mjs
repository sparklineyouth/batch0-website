#!/usr/bin/env node
/** Offline Winter curriculum preparation. Never connects to a database or publishes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FALL = '6350c6ac-70f0-4f53-93d5-c99e397185a9';
export const WINTER = 'e3db019a-e723-4614-a5a1-1c2868883f42';
export const FIELD_GUIDE = '482372ab-2d80-4dcc-b966-3e762114064a';
const DAY = 86400000;
export const windows = Array.from({ length: 9 }, (_, i) => ({
  week: i + 1,
  start: new Date(Date.parse('2026-12-14') + i * 7 * DAY).toISOString().slice(0, 10),
  end: new Date(Math.min(Date.parse('2027-02-12'), Date.parse('2026-12-14') + (i * 7 + 6) * DAY)).toISOString().slice(0, 10),
}));

export function winterId(table, sourceId) {
  // RFC 4122 UUIDv5 in the target cohort namespace: stable across retries.
  const namespace = Buffer.from(WINTER.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(namespace).update(`${table}:${sourceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function adaptText(text, idMap = {}) {
  if (text == null) return text;
  let out = text
    .replaceAll('September 14–November 13, 2026', 'December 14, 2026–February 12, 2027')
    .replaceAll('September 14–November 13', 'December 14, 2026–February 12, 2027')
    .replaceAll('November 13', 'February 12, 2027')
    .replaceAll('Fall 2026', 'Winter 2026')
    .replaceAll('Prepared September 14, 2026', 'Adapted for Winter 2026');
  // Curriculum date windows only; historical publisher checks are not passed here.
  out = out.replace(/2026-(?:09|10|11)-\d{2}/g, value => {
    const shifted = Date.parse(value) + 91 * DAY;
    return new Date(shifted).toISOString().slice(0, 10);
  });
  for (const [before, after] of Object.entries(idMap)) out = out.replaceAll(before, after);
  return out;
}

function pick(row, fields) { return Object.fromEntries(fields.filter(k => k in row).map(k => [k, structuredClone(row[k])])); }
export function prepareRows(snapshot) {
  const records = name => snapshot[name].map(x => x.record);
  const target = records('cohorts').find(x => x.id === WINTER);
  assert.equal(target?.starts_on, '2026-12-14', 'Winter start changed; review schedule before preparing');
  assert.equal(target.ends_on, '2027-02-12', 'Winter end changed; review schedule before preparing');
  assert.equal(target.status, 'upcoming');
  for (const name of ['modules', 'resources']) assert(!records(name).some(x => x.cohort_id === WINTER), `Winter ${name} already exist; use a fresh reconciliation plan`);
  const sourceModules = records('modules').filter(x => x.cohort_id === FALL);
  const sourceIds = new Set(sourceModules.map(x => x.id));
  const sourceLessons = records('lessons').filter(x => sourceIds.has(x.module_id));
  const sourceResources = records('resources').filter(x => x.cohort_id === FALL);
  assert.equal(sourceModules.length, 10);
  assert.equal(sourceLessons.length, 50);
  assert.equal(sourceResources.length, 36);
  const idMap = Object.fromEntries([
    ...sourceModules.map(x => [x.id, winterId('modules', x.id)]),
    ...sourceLessons.map(x => [x.id, winterId('lessons', x.id)]),
    ...sourceResources.map(x => [x.id, winterId('resources', x.id)]),
  ]);
  const remapPath = path => path?.match(/week-\d{2}-workbook\.(pdf|md)$/) ? path.replace('course-launch/fall-2026/', 'course-launch/winter-2026/') : path;
  const modules = sourceModules.map(source => {
    const row = pick(source, ['id','cohort_id','week','title','summary','position']);
    row.id = idMap[source.id]; row.cohort_id = WINTER;
    row.summary = adaptText(row.summary, idMap);
    if (source.id === FIELD_GUIDE) {
      row.title = 'Optional Field Guide — From Problem to Proof';
      row.summary = 'Optional extended practice across Weeks 1–3: interview scripts, problem worksheets, demand tests, and a Lean Canvas. Follow the main weekly workbook for required work. Ten conversations are a stretch target across the validation sprint, not an extra Week 1 deadline.';
    }
    return row;
  });
  const lessons = sourceLessons.map(source => {
    const row = pick(source, ['id','module_id','title','description','duration_seconds','materials','video_path','video_url','position']);
    row.id = idMap[source.id]; row.module_id = idMap[source.module_id];
    row.description = adaptText(row.description, idMap);
    row.materials = (row.materials ?? []).map(m => ({ ...m, path: remapPath(m.path) }));
    if (source.module_id === FIELD_GUIDE) {
      row.description = '**Optional extended practice across Weeks 1–3.** Follow the main weekly workbook for required work. This guide can be spread across the validation sprint; ten conversations are a stretch target. Its day-by-day sequence is a suggested practice plan, not an additional Week 1 deadline.\n\n' + row.description;
    }
    return row;
  });
  const resources = sourceResources.map(source => {
    const row = pick(source, ['id','cohort_id','category','title','description','storage_path','external_url','size_bytes','mime_type','pre_cohort']);
    row.id = idMap[source.id]; row.cohort_id = WINTER;
    row.storage_path = remapPath(row.storage_path);
    // Keep actual historical publisher-check dates; never imply a new check occurred.
    return row;
  });
  return { cohort: target, modules, lessons, resources, idMap, windows };
}

export function contentBatches(manifest) {
  // Each module shares its preview batch with its children so MCP can validate new references.
  const groups = manifest.modules.map(record => [{ table: 'modules', record },
    ...manifest.lessons.filter(l => l.module_id === record.id).map(record => ({ table: 'lessons', record }))]);
  for (let i = 0; i < manifest.resources.length; i += 20) groups.push(manifest.resources.slice(i, i + 20).map(record => ({ table: 'resources', record })));
  assert(groups.every(g => g.length <= 25));
  return groups.map(changes => ({ dry_run: true, reason: 'Prepare the complete Winter 2026 curriculum with separate dated workbooks and evergreen shared templates; preserve all Fall content.', changes }));
}

export async function build(snapshotPath, sourceRoot, outputDirectory) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const manifest = prepareRows(snapshot);
  const original = JSON.parse(await readFile(resolve(sourceRoot, 'content/course-launch/manifest.json'), 'utf8'));
  const liveLessons = new Map(snapshot.lessons.map(x => [x.record.id, x.record]));
  for (const lesson of original.lessons) assert.equal(lesson.description, liveLessons.get(lesson.id)?.description, `Workbook source drift for ${lesson.id}; merge current teaching content first`);
  const output = resolve(outputDirectory);
  const generated = resolve(output, 'generated');
  await mkdir(generated, { recursive: true, mode: 0o700 });
  const { chromium } = await import(pathToFileURL(resolve(sourceRoot, 'node_modules/playwright/index.mjs')).href);
  const { rowSchemas, uploadSchema } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/dist/schemas.js')).href);
  const { validatePrintableHtml } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/dist/html.js')).href);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const assets = [];
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    for (const w of windows) {
      const stem = `week-${String(w.week).padStart(2,'0')}-workbook`;
      const source = resolve(sourceRoot, 'content/course-launch/generated');
      const html = adaptText(await readFile(resolve(source, `${stem}.html`), 'utf8'), manifest.idMap);
      const md = adaptText(await readFile(resolve(source, `${stem}.md`), 'utf8'), manifest.idMap);
      assert(!/(?:Fall 2026|September 14|November 13|2026-(?:09|10|11)-\d\d)/.test(html + md));
      for (const oldId of Object.keys(manifest.idMap)) assert(!(html + md).includes(oldId), `Old course link: ${oldId}`);
      validatePrintableHtml(html);
      await writeFile(resolve(generated, `${stem}.html`), html, { mode: 0o600 });
      await writeFile(resolve(generated, `${stem}.md`), md, { mode: 0o600 });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format:'Letter', printBackground:true, displayHeaderFooter:true,
        headerTemplate:'<div></div>',
        footerTemplate:'<div style="font:9px Arial;color:#59635d;width:100%;text-align:center">batch0 · Winter 2026 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margin:{top:'16mm',bottom:'18mm',left:'16mm',right:'16mm'} });
      await page.close();
      await writeFile(resolve(generated, `${stem}.pdf`), pdf, { mode: 0o600 });
      for (const [extension, buckets, bytes, mime] of [['pdf',['course-materials','resources'],pdf,'application/pdf'], ['md',['course-materials'],Buffer.from(md),'text/markdown']]) {
        for (const bucket of buckets) {
          const path = `course-launch/winter-2026/${stem}.${extension}`;
          const payload = extension === 'pdf' ? { pdf_base64: bytes.toString('base64') } : { text: bytes.toString('utf8') };
          uploadSchema.parse({ bucket, path, ...payload, dry_run: true, reason: 'Prepare original Winter workbook with correct dates and course links.' });
          assets.push({ bucket, path, local_path: resolve(generated, `${stem}.${extension}`), size_bytes: bytes.length, sha256: digest(bytes), mime_type: mime });
          for (const resource of manifest.resources) if (bucket === 'resources' && resource.storage_path === path) resource.size_bytes = bytes.length;
        }
      }
    }
  } finally { await browser.close(); }
  const sharedAssets = original.assets.filter(a => a.path.endsWith('.csv'));
  for (const asset of sharedAssets) {
    const path = resolve(sourceRoot, 'content/course-launch/generated', basename(asset.path));
    const bytes = await readFile(path);
    assert.equal(digest(bytes), asset.sha256, `Shared CSV source changed: ${asset.path}`);
    assert(!/(?:Fall 2026|September|October|November|2026-)/.test(bytes.toString('utf8')), `CSV is dated: ${asset.path}`);
  }
  for (const table of ['modules','lessons','resources']) for (const row of manifest[table]) rowSchemas[table].parse(row);
  const complete = { version: 1, name: 'batch0-winter-2026-curriculum', prepared_on: '2026-09-26', source_snapshot: resolve(snapshotPath), ...manifest, assets,
    reused_assets: sharedAssets.map(({ bucket, path, size_bytes, sha256 }) => ({ bucket, path, size_bytes, sha256 })),
    shared_global_resource_count: snapshot.resources.filter(x => x.record.cohort_id === null).length,
    schedule_note: 'Curriculum windows only. Live events and holiday appointments are a separate reviewed plan; this preparation never creates events or rooms.' };
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(complete, null, 2) + '\n', { mode: 0o600 });
  const batches = contentBatches(complete);
  for (const [i, input] of batches.entries()) await writeFile(resolve(output, `preview-${String(i+1).padStart(2,'0')}.json`), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ modules: complete.modules.length, lessons: complete.lessons.length, resources: complete.resources.length, new_uploads: assets.length, reused_csv_objects: sharedAssets.length, global_resources_unchanged: complete.shared_global_resource_count, preview_batches: batches.length, manifest: resolve(output, 'manifest.json'), mutations: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 3, 'Usage: node scripts/cohort-readiness-winter.mjs SNAPSHOT.json ORIGINAL_REPO PRIVATE_OUTPUT_DIR');
  assert(args.every(a => !a.startsWith('--')), 'This offline preparation has no apply or database options.');
  await build(...args);
}
