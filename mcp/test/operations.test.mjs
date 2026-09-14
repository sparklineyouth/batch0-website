import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Batch0Client } from '../dist/client.js';
import { Operations, fingerprint, fullColumns } from '../dist/operations.js';
import { COHORT, MODULE, LESSON, mockApi } from './mock.mjs';
const reason='Prepare original fixture course for kickoff';
const moduleRow={id:MODULE,cohort_id:COHORT,week:1,title:'Discovery',summary:'Learn to interview',position:0};
const lessonRow={id:LESSON,module_id:MODULE,title:'Interview practice',description:'Ask about the last actual occurrence.',position:0};
async function harness(t, writes=true) {
  const mock=mockApi(), dir=await mkdtemp(join(tmpdir(),'batch0-mcp-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={supabaseUrl:'https://fixture.supabase.co',serviceKey:'secret-key',writesEnabled:writes,auditPath:join(dir,'audit.jsonl')};
  return {...mock,config,ops:new Operations(new Batch0Client(config,mock.fetch))};
}
const mutations=h=>h.requests.filter(r=>r.method!=='GET');
test('status returns content counts and cohorts without credentials',async t=>{
  const h=await harness(t); const result=await h.ops.status({});
  assert.equal(result.connected,true);assert.equal(result.counts.lessons,0);assert.equal(result.cohorts[0].id,COHORT);assert.ok(!JSON.stringify(result).includes('secret-key'));assert.equal(mutations(h).length,0);
});
test('dry run validates dependent inserts without writes or audit',async t=>{
  const h=await harness(t); const r=await h.ops.upsert({changes:[{table:'modules',record:moduleRow},{table:'lessons',record:lessonRow}],reason});
  assert.equal(r.dry_run,true);assert.deepEqual(r.changes.map(x=>x.operation),['insert','insert']);assert.equal(mutations(h).length,0);await assert.rejects(stat(h.config.auditPath),{code:'ENOENT'});
});
test('read-only process rejects explicit apply and upload',async t=>{
  const h=await harness(t,false); await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:moduleRow}],reason,dry_run:false}),/Writes are disabled/);
  await assert.rejects(h.ops.upload({bucket:'resources',path:'mcp/readme.md',text:'Original',reason,dry_run:false}),/Writes are disabled/);assert.equal(mutations(h).length,0);
});
test('strict schemas reject table escape, extra fields, unsafe URLs and traversal',async t=>{
  const h=await harness(t);
  await assert.rejects(h.ops.list({table:'profiles'}));
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:{...moduleRow,price_cents:1}}],reason}));
  await assert.rejects(h.ops.upsert({changes:[{table:'resources',record:{id:LESSON,cohort_id:COHORT,category:'general',title:'Bad',pre_cohort:false,external_url:'javascript:alert(1)'}}],reason}));
  await assert.rejects(h.ops.upload({bucket:'resources',path:'mcp/../secret.md',text:'x',reason}));
  assert.equal(h.requests.length,0);
});
test('apply saves modules before lessons and writes private durable audit',async t=>{
  const h=await harness(t); const r=await h.ops.upsert({changes:[{table:'modules',record:moduleRow},{table:'lessons',record:lessonRow}],reason,dry_run:false});
  assert.equal(r.success,true);assert.equal(h.state.modules.length,1);assert.equal(h.state.lessons.length,1);assert.equal(mutations(h).length,2);
  const log=await readFile(h.config.auditPath,'utf8');assert.equal(log.trim().split('\n').length,4);assert.ok(!log.includes('Ask about'));assert.ok(!log.includes('secret-key'));assert.equal((await stat(h.config.auditPath)).mode&0o777,0o600);
});
test('existing rows require fresh hashes, preserve omitted fields, and reject scope movement',async t=>{
  const h=await harness(t);h.state.modules.push({...moduleRow,created_at:'2026-09-01'});
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:moduleRow}],reason}),/current expected_hash/);
  const first=await h.ops.get({table:'modules',id:MODULE});
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:{...moduleRow,cohort_id:LESSON},expected_hash:first.hash}],reason}),/Moving/);
  const {summary,...record}=moduleRow;
  const r=await h.ops.upsert({changes:[{table:'modules',record:{...record,title:'Discovery revised'},expected_hash:first.hash}],reason,dry_run:false});
  assert.equal(r.success,true);assert.equal(h.state.modules[0].summary,summary);
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:moduleRow,expected_hash:first.hash}],reason}),/changed/);
});
test('preflight rejects missing parent and duplicate titles before any apply',async t=>{
  const h=await harness(t);await assert.rejects(h.ops.upsert({changes:[{table:'lessons',record:lessonRow}],reason,dry_run:false}),/does not exist/);
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:moduleRow},{table:'modules',record:{...moduleRow,id:LESSON}}],reason,dry_run:false}),/title already exists/);
  assert.equal(mutations(h).length,0);
});
test('partial apply reports completed identities and sanitized failure',async t=>{
  const h=await harness(t);const r=await h.ops.upsert({changes:[{table:'modules',record:moduleRow},{table:'lessons',record:{...lessonRow,title:'FORCE API FAILURE'}}],reason,dry_run:false});
  assert.equal(r.success,false);assert.equal(r.applied[0].id,MODULE);assert.equal(h.state.modules.length,1);assert.equal(h.state.lessons.length,0);assert.ok(!JSON.stringify(r).includes('secret-key'));
});
test('list pagination does not silently drop rows and prevents unsupported filters',async t=>{
  const h=await harness(t);h.state.modules.push(moduleRow,{...moduleRow,id:LESSON,title:'Second'});
  const first=await h.ops.list({table:'modules',cohort_id:COHORT,limit:1});assert.equal(first.next_offset,1);assert.equal(first.total,2);
  const second=await h.ops.list({table:'modules',cohort_id:COHORT,limit:1,offset:1,include_content:true});assert.equal(second.next_offset,null);assert.equal(second.rows[0].hash,fingerprint(second.rows[0].record));
  await assert.rejects(h.ops.list({table:'lessons',cohort_id:COHORT}),/filters only/);
});
test('upload is private, explicitly non-overwriting, and records correct bytes',async t=>{
  const h=await harness(t);const r=await h.ops.upload({bucket:'course-materials',path:'course-launch/week1.md',text:'A café worksheet',reason,dry_run:false});
  assert.equal(r.size_bytes,17);assert.equal(r.success,true);const request=mutations(h)[0];assert.equal(request.headers['x-upsert'],'false');assert.equal(request.url.pathname,'/storage/v1/object/course-materials/course-launch/week1.md');
});
test('kickoff defaults to preview, checks hashes, and prevents unsafe links',async t=>{
  const h=await harness(t);const input={cohort_id:COHORT,record:{headline:'Fall kickoff',time_label:'8 PM Eastern',checklist:[{label:'Course',href:'/dashboard/course'}]},reason};
  const preview=await h.ops.kickoff(input);assert.equal(preview.dry_run,true);assert.equal(mutations(h).length,0);
  const saved=await h.ops.kickoff({...input,dry_run:false});assert.equal(saved.success,true);
  const current=await h.ops.get({table:'cohort_kickoff',id:COHORT});assert.equal(current.record.headline,'Fall kickoff');
  await assert.rejects(h.ops.kickoff(input),/exists or changed/);
  await assert.rejects(h.ops.kickoff({...input,record:{checklist:[{label:'bad',href:'//evil.example'}]}}));
});
test('printable HTML permits static worksheets and rejects executable or fetching content',async t=>{
  const h=await harness(t);
  const base={bucket:'course-materials',path:'course-launch/worksheet.html',reason};
  const safe='<!doctype html><html lang="en"><head><meta charset="utf-8"><style>@media print { body { color: #111; } }</style></head><body><h1>Worksheet</h1><table><tr><td>Name</td></tr></table><a href="https://example.com/source">Source</a></body></html>';
  assert.equal((await h.ops.upload({...base,text:safe})).dry_run,true);
  for (const text of ['<script>alert(1)</script>','<iframe src="https://example.com"></iframe>','<p onclick="alert(1)">x</p>','<style>body{background:url(https://example.com)}</style>','<svg onload="alert(1)"></svg>','<meta http-equiv="refresh" content="0;url=https://example.com">','<style>body{background:u\\72l(https://example.com)}</style>','<a href="javascript:alert(1)">x</a>']) await assert.rejects(h.ops.upload({...base,text}));
  assert.equal(mutations(h).length,0);
});
test('audit failure blocks the database mutation',async t=>{
  const h=await harness(t);h.config.auditPath='/dev/null/not-a-directory/audit.jsonl';
  await assert.rejects(h.ops.upsert({changes:[{table:'modules',record:moduleRow}],reason,dry_run:false}));assert.equal(mutations(h).length,0);
});
test('network redirects are forbidden and API errors never echo upstream secrets',async t=>{
  const h=await harness(t);let options;
  const client=new Batch0Client(h.config,async(_url,init)=>{options=init;return new Response('secret-key is present here',{status:401});});
  await assert.rejects(client.list('modules',new URLSearchParams()),error=>error.message.includes('HTTP 401')&&!error.message.includes('secret-key'));
  assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
});
test('PDF upload accepts original binary PDF and preserves private MIME/bytes',async t=>{
  const h=await harness(t);const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const input={bucket:'course-materials',path:'course-launch/worksheet.pdf',pdf_base64:pdf.toString('base64'),reason,dry_run:false};
  const r=await h.ops.upload(input);assert.equal(r.success,true);assert.equal(r.size_bytes,pdf.length);assert.equal(r.mime_type,'application/pdf');
  const req=mutations(h)[0];assert.equal(req.headers['Content-Type'],'application/pdf');assert.equal(req.headers['x-upsert'],'false');assert.deepEqual(req.body,pdf);
});
test('PDF upload rejects text/binary mismatch, mixed inputs, invalid/oversize base64, and active PDF actions',async t=>{
  const h=await harness(t);const pdf=Buffer.from('%PDF-1.7\n%%EOF\n').toString('base64');const base={bucket:'resources',path:'mcp/test.pdf',reason};
  for(const extra of [{text:'Hello'},{pdf_base64:pdf,text:'Hello'},{pdf_base64:'@@not base64@@'},{pdf_base64:'YWJj'},{pdf_base64:Buffer.alloc(2*1024*1024+1,32).toString('base64')},{pdf_base64:Buffer.from('%PDF-1.7\n/JavaScript (bad)\n%%EOF\n').toString('base64')},{pdf_base64:Buffer.from('%PDF-1.7\nNo EOF').toString('base64')},{pdf_base64:pdf,path:'mcp/test.html'}]) await assert.rejects(h.ops.upload({...base,...extra}));
  assert.equal(mutations(h).length,0);
});
test('PDF guard uses PDF name delimiters, not JavaScript word boundaries in compressed bytes',async t=>{
  const h=await harness(t);
  const pdf=Buffer.concat([Buffer.from('%PDF-1.7\nstream\n/JS'),Buffer.from([0xcb,0xc3]),Buffer.from('\nendstream\n%%EOF\n')]);
  const r=await h.ops.upload({bucket:'resources',path:'mcp/compressed-fixture.pdf',pdf_base64:pdf.toString('base64'),reason});assert.equal(r.dry_run,true);
});
