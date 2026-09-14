#!/usr/bin/env node
// Uses the real stdio MCP protocol. Defaults to preview; --apply is explicit.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const manifestFile = process.argv.find(x => x.endsWith('manifest.json')) ?? resolve(root, 'content/course-launch/manifest.json');
const source = await readFile(manifestFile, 'utf8');
const manifest = JSON.parse(source);
const digest = text => createHash('sha256').update(text).digest('hex');
const manifestHash = digest(source);
const output = resolve(root, 'out/course-launch-import');
await mkdir(output, { recursive: true, mode: 0o700 });
const receiptFile = resolve(output, `receipts-${manifestHash.slice(0, 12)}.json`);
let receipts = { manifest_hash: manifestHash, assets: [], records: [] };
try { receipts = JSON.parse(await readFile(receiptFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.equal(receipts.manifest_hash, manifestHash);
const client = new Client({ name: 'batch0-curriculum-import', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve(root, 'mcp/dist/index.js')],
  env: { PATH: process.env.PATH, BATCH0_ENV_FILE: resolve(root, '.env.local'), BATCH0_MCP_ALLOW_WRITES: String(apply) }, stderr: 'pipe',
});
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
  if (result.isError || value.success === false) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
async function saveReceipts() { await writeFile(receiptFile, JSON.stringify(receipts, null, 2) + '\n', { mode: 0o600 }); }
const reason = 'Prepare the complete original Fall 2026 nine-week curriculum for the September 14 kickoff, as requested by the founder.';
try {
  await client.connect(transport);
  const status = await call('batch0_status');
  assert.equal(status.connected, true);
  const cohort = (await call('batch0_get_record', { table: 'cohorts', id: manifest.cohort.id })).record;
  assert.equal(cohort.starts_on, manifest.cohort.starts_on);
  assert.equal(cohort.ends_on, manifest.cohort.ends_on);
  const assets = [];
  for (const asset of manifest.assets) {
    const localPath = resolve(dirname(manifestFile), asset.local_path);
    assert.ok(localPath.startsWith(resolve(root, 'content/course-launch') + '/'), 'Only local course assets are allowed');
    const bytes = await readFile(localPath);
    assert.equal(digest(bytes), asset.sha256, `Asset changed: ${asset.path}`);
    assert.equal(bytes.byteLength, asset.size_bytes);
    const payload = asset.path.endsWith('.pdf') ? { pdf_base64: bytes.toString('base64') } : { text: bytes.toString('utf8') };
    const input = { bucket: asset.bucket, path: asset.path, ...payload, reason };
    await call('batch0_upload_material', { ...input, dry_run: true });
    assets.push(input);
  }
  const groups = manifest.modules.map(record => [{ table: 'modules', record }, ...manifest.lessons.filter(l => l.module_id === record.id).map(record => ({ table: 'lessons', record }))]);
  for (let i = 0; i < manifest.resources.length; i += 20) groups.push(manifest.resources.slice(i, i + 20).map(record => ({ table: 'resources', record })));
  const before = [];
  const plans = [];
  for (const group of groups) {
    for (const change of group) {
      const existing = await call('batch0_get_record', { table: change.table, id: change.record.id });
      before.push(existing);
      if (existing.hash) change.expected_hash = existing.hash;
    }
    const preview = await call('batch0_upsert_content', { changes: group, dry_run: true, reason });
    plans.push(preview);
  }
  const stamp = new Date().toISOString().replaceAll(':', '-');
  await writeFile(resolve(output, `backup-${stamp}.json`), JSON.stringify({ manifest_hash: manifestHash, before, plans }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', manifest_hash: manifestHash, assets: assets.length, modules: manifest.modules.length, lessons: manifest.lessons.length, resources: manifest.resources.length, changes: plans.flatMap(p => p.changes).reduce((a, p) => (a[p.operation] = (a[p.operation] ?? 0) + 1, a), {}) }));
  if (apply) {
    for (const asset of assets) {
      const existing = receipts.assets.find(x => x.bucket === asset.bucket && x.path === asset.path);
      if (existing) { assert.equal(existing.sha256, digest(asset.pdf_base64 ? Buffer.from(asset.pdf_base64, 'base64') : asset.text)); continue; }
      const result = await call('batch0_upload_material', { ...asset, dry_run: false });
      receipts.assets.push(result); await saveReceipts();
      console.log(`Uploaded ${asset.bucket}/${asset.path}`);
    }
    for (const group of groups) {
      const result = await call('batch0_upsert_content', { changes: group, dry_run: false, reason });
      receipts.records.push(...result.applied); await saveReceipts();
      console.log(`Saved ${result.applied.length} content records`);
    }
    for (const change of groups.flat()) {
      const saved = (await call('batch0_get_record', { table: change.table, id: change.record.id })).record;
      for (const [key, value] of Object.entries(change.record)) assert.deepEqual(saved[key], value, `${change.table}:${change.record.id}.${key}`);
    }
    receipts.verified_at = new Date().toISOString(); await saveReceipts();
    console.log('Verified every saved content field through MCP readback. Private asset uploads are recorded in the receipt journal.');
  } else console.log('Preview passed. No content or storage writes were made.');
} finally { await client.close(); }
