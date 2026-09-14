import { readFile } from 'node:fs/promises';
import { Batch0Client } from '../dist/client.js';
import { Operations, invoke } from '../dist/operations.js';
import { mockApi } from '../test/mock.mjs';
export async function evaluateFixture() {
  const fixture=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
  const mock=mockApi();Object.assign(mock.state,fixture);
  const ops=new Operations(new Batch0Client({supabaseUrl:'https://fixture.supabase.co',serviceKey:'fixture-only',writesEnabled:false,auditPath:'/unused'},mock.fetch));
  const call=(name,args)=>invoke(ops,name,args);
  const status=await call('batch0_status',{});const cohort=status.cohorts.find(c=>c.name==='Example Makers');
  async function list(args){const rows=[];let offset=0;do{const page=await call('batch0_list_records',{...args,limit:1,offset,include_content:true});rows.push(...page.rows.map(r=>r.record));offset=page.next_offset;}while(offset!==null);return rows;}
  const modules=await list({table:'modules',cohort_id:cohort.id});
  const lessons=(await Promise.all(modules.map(m=>list({table:'lessons',module_id:m.id})))).flat();
  const resources=await list({table:'resources',cohort_id:cohort.id});
  const events=await list({table:'events',cohort_id:cohort.id});
  const counts=modules.map(m=>({module:m,count:lessons.filter(l=>l.module_id===m.id).length})).sort((a,b)=>b.count-a.count);
  const workshops=events.filter(e=>e.type==='workshop').sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const officeHours=events.filter(e=>e.type==='office_hours').sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const demo=events.find(e=>e.type==='demo_day');
  const earliestOH=officeHours[0];const firstWeek=Math.floor((Date.parse(earliestOH.starts_at)-Date.parse(cohort.starts_on))/604800000)+1;
  const firstPresentationModule=modules.filter(m=>m.summary?.startsWith('Present')).sort((a,b)=>a.week-b.week)[0];
  const answers=[
    counts[0].module.title,
    String(lessons.filter(l=>l.module_id===modules.find(m=>m.week===1).id).length),
    String(resources.filter(r=>r.pre_cohort&&r.category==='readings').length),
    String((Date.parse(demo.starts_at)-Date.parse(workshops[0].starts_at))/3600000),
    String(lessons.reduce((sum,l)=>sum+(l.materials??[]).filter(m=>m.path.endsWith('.pdf')).length,0)),
    String(lessons.filter(l=>l.description&&!l.video_url&&!l.video_path).length),
    modules.find(m=>m.week===firstWeek).title,
    workshops.find(e=>e.title.startsWith(`Week ${firstPresentationModule.week} `)).starts_at,
    String(new Set(resources.filter(r=>r.category==='templates').map(r=>r.storage_path).filter(Boolean)).size),
    String(lessons.length+resources.length),
  ];
  if(mock.requests.some(r=>r.method!=='GET'))throw new Error('Evaluations must be read-only');
  return {answers,read_calls:mock.requests.length};
}
