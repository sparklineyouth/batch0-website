import test from 'node:test';
import assert from 'node:assert/strict';
import { FALL, WINTER, FIELD_GUIDE, windows, winterId, adaptText, prepareRows, contentBatches } from './cohort-readiness-winter.mjs';

function fixture() {
  const row = record => ({ record, hash: 'read-only-snapshot-hash' });
  const modules = Array.from({ length: 10 }, (_, i) => row({ id: i === 1 ? FIELD_GUIDE : `module-${i}`, cohort_id: FALL, week: Math.max(1,i), position:i+1, title:`Module ${i}`, summary:'2026-09-14–2026-09-20' }));
  return {
    cohorts: [row({ id: WINTER, name:'Winter 2026', starts_on:'2026-12-14', ends_on:'2027-02-12', status:'upcoming' })],
    modules,
    lessons: Array.from({ length: 50 }, (_, i) => row({ id:`lesson-${i}`, module_id:modules[i%10].record.id, title:`Lesson ${i}`, position:Math.floor(i/10)+1, description:'September 14–November 13. By November 13, I want a project.', video_url:null, video_path:null, duration_seconds:null, materials:[{ title:'Workbook', path:'course-launch/fall-2026/week-01-workbook.pdf' },{ title:'CSV', path:'course-launch/fall-2026/funnel.csv' }] })),
    resources: [...Array.from({ length: 36 }, (_, i) => row({ id:`resource-${i}`, cohort_id:FALL, title:`Resource ${i}`, category:'templates', storage_path:'course-launch/fall-2026/week-01-workbook.pdf', pre_cohort:i===0, description:'Publisher link checked 2026-09-14.' })), row({ id:'global', cohort_id:null, title:'Global resource' })],
    events:[row({ id:'fall-event', cohort_id:FALL })], kickoffs:[],
  };
}

test('copy leaves existing Fall records untouched and never migrates global resources', () => {
  const snapshot = fixture(); const before = structuredClone(snapshot);
  const result = prepareRows(snapshot);
  assert.deepEqual(snapshot,before);
  assert.equal(result.resources.length,36);
  assert(result.resources.every(r => r.cohort_id===WINTER && r.id!=='global'));
  assert.equal(result.resources[0].description,'Publisher link checked 2026-09-14.');
  assert.equal(result.resources[0].pre_cohort,true);
});

test('new identities are stable, unique, and scoped to Winter', () => {
  const result=prepareRows(fixture());
  const rows=[...result.modules,...result.lessons,...result.resources];
  assert.equal(new Set(rows.map(r=>r.id)).size,96);
  for (const row of rows) assert.match(row.id,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(winterId('lessons','x'),winterId('lessons','x'));
  assert.notEqual(winterId('modules','x'),winterId('lessons','x'));
  const parents=new Set(result.modules.map(m=>m.id));
  assert(result.lessons.every(l=>parents.has(l.module_id)));
});

test('dates span year boundary and calendar windows cover entire nine-week cohort', () => {
  assert.equal(windows.length,9);
  assert.deepEqual(windows[0],{week:1,start:'2026-12-14',end:'2026-12-20'});
  assert.deepEqual(windows[2],{week:3,start:'2026-12-28',end:'2027-01-03'});
  assert.deepEqual(windows[8],{week:9,start:'2027-02-08',end:'2027-02-12'});
  for(let i=1;i<windows.length;i++) assert.equal(Date.parse(windows[i].start)-Date.parse(windows[i-1].end),86400000);
  assert.equal(adaptText('2026-11-09–2026-11-13'),'2027-02-08–2027-02-12');
});

test('workbook links and stated completion dates cannot send Winter students to Fall', () => {
  const result=prepareRows(fixture());
  const text=adaptText('September 14–November 13, 2026. By November 13. /dashboard/course/lesson-1',result.idMap);
  assert(!text.includes('November') && !text.includes('September'));
  assert(text.includes('December 14, 2026–February 12, 2027'));
  assert(text.includes(`/dashboard/course/${result.idMap['lesson-1']}`));
  assert(result.lessons.every(l=>l.materials[0].path.startsWith('course-launch/winter-2026/')));
  assert(result.lessons.every(l=>l.materials[1].path==='course-launch/fall-2026/funnel.csv'));
});

test('supplementary field guide explicitly avoids an extra Week 1 workload', () => {
  const result=prepareRows(fixture());
  const guide=result.modules.find(m=>m.id===winterId('modules',FIELD_GUIDE));
  assert.match(guide.title,/Optional/);
  assert.match(guide.summary,/Weeks 1–3/);
  assert(result.lessons.filter(l=>l.module_id===guide.id).every(l=>l.description.startsWith('**Optional extended practice across Weeks 1–3.**')));
});

test('MCP preview batches define each new parent before children and cannot publish', () => {
  const batches=contentBatches(prepareRows(fixture()));
  assert.equal(batches.length,12);
  assert.equal(batches.flatMap(b=>b.changes).length,96);
  for(const batch of batches){
    assert.equal(batch.dry_run,true);
    assert(batch.changes.length<=25);
    const parents=new Set();
    for(const change of batch.changes){
      if(change.table==='modules') parents.add(change.record.id);
      if(change.table==='lessons') assert(parents.has(change.record.module_id));
      assert(!['events','cohort_kickoff','cohorts'].includes(change.table));
    }
  }
});

test('refuses changed dates, existing Winter records, and incomplete snapshots', () => {
  const changed=fixture(); changed.cohorts[0].record.ends_on='2027-02-19';
  assert.throws(()=>prepareRows(changed),/end changed/);
  const populated=fixture(); populated.modules.push({record:{id:'existing',cohort_id:WINTER}});
  assert.throws(()=>prepareRows(populated),/already exist/);
  const incomplete=fixture(); incomplete.lessons.pop();
  assert.throws(()=>prepareRows(incomplete));
});
