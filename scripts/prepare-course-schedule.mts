/**
 * Provision an explicitly approved course schedule. Preview by default.
 *
 * node --env-file=.env.local scripts/prepare-course-schedule.mts
 * node --env-file=.env.local scripts/prepare-course-schedule.mts --apply --approved --demo-format=staff-showcase
 * node scripts/prepare-course-schedule.mts --self-test
 *
 * Reads the ignored private proposal; never sends messages, creates meeting
 * tokens, enrolls users, or enables paid recording/large-call features.
 * Deterministic room names and event IDs make interrupted runs resumable.
 * Local snapshots/receipts remain under ignored out/, with private permissions.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import assert from 'node:assert/strict';

const eventSchema = z.object({
  id: z.string().uuid(), cohort_id: z.string().uuid(),
  type: z.enum(['workshop','office_hours','demo_day']), title: z.string().min(1).max(240),
  description: z.string().max(100_000), starts_at: z.string().datetime({offset:true}), ends_at: z.string().datetime({offset:true}),
  visibility: z.literal('enrolled'), live_mode: z.literal('hosted'),
}).passthrough();
const planSchema = z.object({
  cohort: z.object({id:z.string().uuid(),name:z.string(),starts_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),ends_on:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).passthrough(),
  notifications:z.literal(false),time_zone:z.literal('America/New_York'),
  events:z.array(z.object({notifications:z.literal(false),week:z.number().int().min(1).max(52),module_id:z.string().uuid(),local_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time_zone:z.literal('America/New_York'),event:eventSchema}).passthrough()).length(18),
}).passthrough();
type Plan=z.infer<typeof planSchema>;
type Row=Record<string,unknown>;
type Room={name:string;url:string;privacy:string;config?:Record<string,unknown>};
const tz='America/New_York';
const answerInstructions='This is a staff-led broadcast. Ask questions in the private written Q&A panel; student microphones and screen sharing are not enabled.';
const demoDescription='Students prepare a three-minute product demo recording, a PDF pitch deck, and a claims/evidence appendix. Submit through Files and include the links in your Check-in by Wednesday, November 11 at 8:00 p.m. U.S. Eastern (EST) for staff review. A PDF deck with written narration that staff can read is an equally valid alternative; showing your face or sharing contact details is not required. November 12 office hours are for rehearsal and support. On November 13, staff plays or shares reviewed submissions and students answer moderated written Q&A. Students do not take a live microphone or share their own screens in this format. No outside guests, funding, or prizes are promised.';
function localParts(iso:string){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'}).formatToParts(new Date(iso)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function validatePlan(raw:unknown):Plan{
  const p=planSchema.parse(raw);const counts={workshop:0,office_hours:0,demo_day:0};const ids=new Set<string>();
  for(const item of p.events){const e=item.event;counts[e.type]++;if(ids.has(e.id))throw new Error('Duplicate event UUID in proposal');ids.add(e.id);
    if(e.cohort_id!==p.cohort.id)throw new Error('Event cohort does not match proposal');
    const local=localParts(e.starts_at);const date=`${local.year}-${local.month}-${local.day}`;
    if(date!==item.local_date||local.hour!=='20'||local.minute!=='00')throw new Error('Start time must round-trip to the approved 8 PM Eastern local date');
    if(local.weekday!==({workshop:'Mon',office_hours:'Thu',demo_day:'Fri'} as const)[e.type])throw new Error('Event weekday does not match approved schedule pattern');
    if(Date.parse(e.ends_at)-Date.parse(e.starts_at)!==(e.type==='office_hours'?30:60)*60000)throw new Error('Event duration differs from the approved schedule');
    if(item.local_date<=p.cohort.starts_on||item.local_date>p.cohort.ends_on)throw new Error('Proposal must exclude kickoff and stay within the cohort');
    const expectedWeek=Math.floor((Date.parse(item.local_date)-Date.parse(p.cohort.starts_on))/604800000)+1;
    if(item.week!==expectedWeek)throw new Error('Event does not match its curriculum week');
  }
  if(counts.workshop!==8||counts.office_hours!==9||counts.demo_day!==1)throw new Error('Expected eight workshops, nine office hours, and one Demo Day');
  return p;
}
function roomName(item:Plan['events'][number]){return `b0-${item.event.cohort_id.slice(0,8)}-${item.event.type==='office_hours'?'oh':item.event.type==='demo_day'?'demo':'ws'}-${item.local_date.replaceAll('-','')}-${item.event.id.slice(0,8)}`;}
function roomProperties(item:Plan['events'][number]){return{exp:Date.parse(item.event.ends_at)/1000+7200,eject_at_room_exp:true,owner_only_broadcast:true,enable_screenshare:true,enable_chat:false,enable_prejoin_ui:false};}
function checkRoom(room:Room,item:Plan['events'][number]){
  const c=room.config??{};const expected=roomProperties(item);
  // Daily omits enable_screenshare:true from persisted room config because true
  // is its documented default. Domain overrides are checked before room reads.
  // https://docs.daily.co/reference/rest-api/rooms/create-room
  if(room.name!==roomName(item)||room.privacy!=='private'||c.owner_only_broadcast!==true||c.enable_chat!==false||c.eject_at_room_exp!==true||c.exp!==expected.exp||(c.enable_screenshare!==undefined&&c.enable_screenshare!==true)||c.enable_prejoin_ui!==false)throw new Error(`Room ${roomName(item)} does not match approved privacy/expiry settings; refusing to modify it`);
  if(c.enable_recording||c.experimental_optimize_large_calls||c.enable_transcription_storage||c.enable_dialout)throw new Error('Existing room has paid or unapproved features enabled');
  const url=new URL(room.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.daily.co')||url.username||url.password)throw new Error('Daily returned an unexpected room URL');
}
function payloadFor(item:Plan['events'][number],room:Room,before:Row|null):Row{
  const e=item.event;const rehearsal=e.type==='office_hours'&&item.week===9;
  return{id:e.id,cohort_id:e.cohort_id,type:e.type,title:e.type==='demo_day'?'Demo Day — student showcase and moderated Q&A':e.title,
    description:e.type==='demo_day'?demoDescription:`${e.description}${rehearsal?' This session includes rehearsal and support for the staff-hosted student showcase. Bring your submitted demo or deck and your remaining questions.':''} ${answerInstructions}`,
    starts_at:e.starts_at,ends_at:e.ends_at,location:'Live on batch0.org',zoom_url:null,recording_url:before?.recording_url??null,
    visibility:'enrolled',live_mode:'hosted',daily_room_name:room.name,daily_room_url:room.url};
}
function matches(existing:Row,payload:Row){return Object.entries(payload).every(([key,value])=>['starts_at','ends_at'].includes(key)?Date.parse(String(existing[key]))===Date.parse(String(value)):JSON.stringify(existing[key])===JSON.stringify(value));}
function checkExisting(existing:Row|null,item:Plan['events'][number]){
  if(existing&&(existing.cohort_id!==item.event.cohort_id||existing.type!==item.event.type||Date.parse(String(existing.starts_at))!==Date.parse(item.event.starts_at)||(existing.daily_room_name&&existing.daily_room_name!==roomName(item))))throw new Error(`Event ${item.event.id} is occupied by a different session; refusing overwrite`);
}
async function privateJson(path:string,value:unknown){const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);return value;}
async function daily(path:string,body?:object):Promise<Room|null>{
  let r:Response;try{r=await fetch(`https://api.daily.co/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${required('DAILY_API_KEY')}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Error('Daily request failed or timed out; inspect the deterministic room before retrying');}
  if(r.status===404&&!body)return null;if(!r.ok)throw new Error(`Daily returned HTTP ${r.status}; no provider body or credentials printed`);return await r.json() as Room;
}
async function main(){
  const apply=process.argv.includes('--apply');if(apply&&!process.argv.includes('--approved'))throw new Error('Applying requires --approved after the exact schedule is approved');
  if(apply&&!process.argv.includes('--demo-format=staff-showcase'))throw new Error('Applying requires the approved --demo-format=staff-showcase; student live broadcast is not supported');
  const flag=process.argv.find(a=>a.startsWith('--plan='));const planPath=resolve(flag?.slice(7)??'content/course-launch/proposed-schedule.json');
  const source=await readFile(planPath,'utf8');const plan=validatePlan(JSON.parse(source));const planHash=hash(source);
  const url=new URL(required('NEXT_PUBLIC_SUPABASE_URL'));if(url.protocol!=='https:'||!/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('Supabase must be a trusted HTTPS project origin');
  required('DAILY_API_KEY');const sb=createClient(url.origin,required('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)})}});
  const domain=await daily('/');const domainConfig=domain?.config??{};
  if(domainConfig.enable_screenshare===false||domainConfig.enable_recording||domainConfig.experimental_optimize_large_calls||domainConfig.enable_transcription_storage||domainConfig.enable_dialout)throw new Error('Daily domain has an incompatible screenshare override or unapproved paid features');
  const [cohortResult,eventResult,moduleResult]=await Promise.all([
    sb.from('cohorts').select('id,name,starts_on,ends_on,status').eq('id',plan.cohort.id).single(),
    sb.from('events').select('*').eq('cohort_id',plan.cohort.id),
    sb.from('modules').select('id,cohort_id,week').eq('cohort_id',plan.cohort.id),
  ]);
  if(cohortResult.error||eventResult.error||moduleResult.error)throw new Error('Could not read cohort, modules, and current events; no mutations performed');
  if(cohortResult.data.starts_on!==plan.cohort.starts_on||cohortResult.data.ends_on!==plan.cohort.ends_on||cohortResult.data.status==='cancelled')throw new Error('Live cohort dates/status differ from the approved proposal');
  const beforeRows=eventResult.data as Row[];const beforeById=new Map(beforeRows.map(row=>[String(row.id),row]));const rooms=new Map<string,Room|null>();
  for(const item of plan.events){
    if(!moduleResult.data.some(m=>m.id===item.module_id&&m.week===item.week))throw new Error('A proposal module is absent or has a different week');
    checkExisting(beforeById.get(item.event.id)??null,item);
    if(beforeRows.some(row=>row.id!==item.event.id&&row.type===item.event.type&&Date.parse(String(row.starts_at))===Date.parse(item.event.starts_at)))throw new Error('An event with this type/time already exists under another UUID; inspect duplicates before continuing');
    if(Date.now()>=Date.parse(item.event.ends_at))throw new Error('Refusing to provision a past event');
    const room=await daily(`/rooms/${roomName(item)}`);if(room)checkRoom(room,item);rooms.set(item.event.id,room);
  }
  console.log(JSON.stringify({mode:apply?'apply':'preview',cohort:plan.cohort.name,plan_hash:planHash,events:plan.events.length,existing_events:plan.events.filter(i=>beforeById.has(i.event.id)).length,existing_rooms:[...rooms.values()].filter(Boolean).length,counts:{workshop:8,office_hours:9,demo_day:1},demo_format:'staff showcase of submitted work and moderated written Q&A',notifications:false,paid_features_requested:false,time_zone:tz},null,2));
  if(!apply)return;
  const runId=randomUUID();const out=resolve(`out/course-schedule-${Date.now()}-${runId.slice(0,8)}`);await mkdir(out,{recursive:true,mode:0o700});
  await privateJson(`${out}/before.json`,{run_id:runId,plan_hash:planHash,cohort:cohortResult.data,events:beforeRows,rooms:Object.fromEntries(rooms)});
  await privateJson(`${out}/intent.json`,{run_id:runId,plan_hash:planHash,event_ids:plan.events.map(i=>i.event.id),approved:true,demo_format:'staff-showcase',notifications:false,paid_features_requested:false});
  const applied:Row[]=[];
  try{
    for(const item of plan.events){
      const currentResult=await sb.from('events').select('*').eq('id',item.event.id).maybeSingle();if(currentResult.error)throw new Error('Cannot recheck event before apply');
      const current=currentResult.data as Row|null;checkExisting(current,item);if(hash(current)!==hash(beforeById.get(item.event.id)??null))throw new Error('An event changed during preflight; inspect current data before retrying');
      let room=rooms.get(item.event.id)??null;let createdRoom=false;
      if(!room){room=await daily('/rooms',{name:roomName(item),privacy:'private',properties:roomProperties(item)});if(!room)throw new Error('Daily did not return a created room');createdRoom=true;checkRoom(room,item);await privateJson(`${out}/room-${item.event.id}.json`,{id:item.event.id,room,automatic_expiry:true});}
      const payload=payloadFor(item,room,current);let saved:Row;
      if(current&&matches(current,payload)){saved=current;}else{
        const result=await sb.from('events').upsert(payload,{onConflict:'id'}).select('*').single();if(result.error)throw new Error(`Event write failed (${result.error.code}); any created room expires automatically`);saved=result.data;
      }
      if(!matches(saved,payload))throw new Error('Event readback did not match the approved payload');
      const result={id:payload.id,type:payload.type,title:payload.title,starts_at:payload.starts_at,ends_at:payload.ends_at,room_name:room.name,room_created:createdRoom,event_changed:!(current&&matches(current,payload)),expires_at:new Date(Number(room.config?.exp)*1000).toISOString(),join_url:`https://batch0.org/dashboard/events/${payload.id}/live`,notifications:false};
      applied.push(result);await privateJson(`${out}/event-${item.event.id}.json`,{...result,saved});
      if(result.event_changed||createdRoom){const audit=await sb.from('audit_log').insert({action:'course_schedule.prepared',target_type:'event',target_id:item.event.id,payload:{run_id:runId,plan_hash:planHash,source:'User-approved course schedule',starts_at:payload.starts_at,paid_features:false,notifications:false,demo_format:item.event.type==='demo_day'?'staff-showcase':null}});if(audit.error)throw new Error('Event saved but database audit failed; inspect receipt before retrying');}
    }
    const finalRead=await sb.from('events').select('id,type,starts_at,ends_at,visibility,live_mode,daily_room_name,daily_room_url').in('id',plan.events.map(i=>i.event.id));if(finalRead.error||finalRead.data.length!==18)throw new Error('Final database verification did not return all eighteen events');
    for(const item of plan.events){const room=await daily(`/rooms/${roomName(item)}`);if(!room)throw new Error('A provisioned room is missing during final verification');checkRoom(room,item);}
    await privateJson(`${out}/complete.json`,{success:true,run_id:runId,plan_hash:planHash,count:applied.length,events:applied,notifications:false,paid_features_requested:false});
    console.log(JSON.stringify({success:true,count:applied.length,rooms_created:applied.filter(r=>r.room_created).length,events_changed:applied.filter(r=>r.event_changed).length,receipts:out,notifications:false,paid_features_requested:false}));
  }catch(error){const message=error instanceof Error?error.message:'Unknown schedule preparation failure';await privateJson(`${out}/failure.json`,{success:false,run_id:runId,error:message,applied,requires_readback_before_retry:true});throw new Error(`${message}. Private receipts: ${out}; completed events: ${applied.length}.`);}
}
async function selfTest(){
  const base={notifications:false as const,week:3,module_id:'20000000-0000-4000-8000-000000000001',local_date:'2026-11-02',time_zone:'America/New_York' as const,event:{id:'30000000-0000-4000-8000-000000000001',cohort_id:'10000000-0000-4000-8000-000000000001',type:'workshop' as const,title:'Example workshop',description:'Synthetic example',starts_at:'2026-11-03T01:00:00.000Z',ends_at:'2026-11-03T02:00:00.000Z',visibility:'enrolled' as const,live_mode:'hosted' as const}};
  assert.equal(localParts('2026-10-27T00:00:00Z').hour,'20');assert.equal(localParts('2026-10-27T00:00:00Z').timeZoneName,'EDT');assert.equal(localParts(base.event.starts_at).hour,'20');assert.equal(localParts(base.event.starts_at).timeZoneName,'EST');
  const props=roomProperties(base);assert.equal(props.exp,Date.parse(base.event.ends_at)/1000+7200);assert.equal(props.owner_only_broadcast,true);assert.equal(props.enable_chat,false);assert.ok(!('enable_recording'in props));assert.ok(!('experimental_optimize_large_calls'in props));
  const room:Room={name:roomName(base),url:`https://example.daily.co/${roomName(base)}`,privacy:'private',config:props};checkRoom(room,base);checkRoom({...room,config:{...props,enable_screenshare:undefined}},base);assert.throws(()=>checkRoom({...room,config:{...props,enable_screenshare:false}},base));assert.throws(()=>checkRoom({...room,privacy:'public'},base));assert.throws(()=>checkRoom({...room,config:{...props,enable_chat:true}},base));assert.throws(()=>checkRoom({...room,config:{...props,enable_recording:'cloud'}},base));
  const payload=payloadFor(base,room,null);assert.equal(payload.visibility,'enrolled');assert.ok(matches(payload,payload));assert.ok(matches({...payload,starts_at:'2026-11-03T01:00:00+00:00'},payload));assert.equal(roomName(base),roomName(structuredClone(base)));checkExisting(payload,base);assert.throws(()=>checkExisting({...payload,cohort_id:'another'},base));
  const demo=payloadFor({...base,event:{...base.event,type:'demo_day'}},room,null);assert.equal(demo.title,'Demo Day — student showcase and moderated Q&A');assert.ok(String(demo.description).includes('Students do not take a live microphone'));assert.ok(String(demo.description).includes('Wednesday, November 11'));assert.ok(!JSON.stringify(props).includes('token'));
  console.log('Schedule self-test passed: DST, deterministic identities, privacy, expiry, paid-feature exclusion, readback comparison, conflict guards, and honest showcase format.');
}
try{if(process.argv.includes('--self-test'))await selfTest();else await main();}catch(error){console.error(error instanceof Error?error.message:'Schedule preparation failed');process.exitCode=1;}
