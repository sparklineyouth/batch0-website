import { createServer } from 'node:http';
export const COHORT = '10000000-0000-4000-8000-000000000001';
export const MODULE = '20000000-0000-4000-8000-000000000001';
export const LESSON = '30000000-0000-4000-8000-000000000001';
export function mockApi() {
  const state = { cohorts: [{id:COHORT,name:'Fixture cohort',status:'upcoming',starts_on:'2026-09-14'}], modules: [], lessons: [], resources: [], events: [], cohort_kickoff: [] };
  const requests = [];
  const fetch = async (input, init={}) => {
    const u = new URL(input);
    const method = init.method ?? 'GET';
    requests.push({url:u, method, body:init.body, headers:init.headers});
    const table = u.pathname.split('/').at(-1);
    if (u.pathname.startsWith('/storage/')) return new Response(JSON.stringify({Key:u.pathname}), {status:200});
    if (!state[table]) return new Response('missing table', {status:404});
    const key = table === 'cohort_kickoff' ? 'cohort_id' : 'id';
    const filtered = state[table].filter(row => [...u.searchParams.entries()].every(([k,v]) => ['select','order','offset','limit'].includes(k) || (v === 'is.null' ? row[k] === null : String(row[k]) === v.slice(3))));
    if (method === 'GET') {
      const offset = Number(u.searchParams.get('offset')??0), limit=Number(u.searchParams.get('limit')??100);
      const rows = filtered.slice(offset,offset+limit).map(row => {
        const cols = u.searchParams.get('select');
        return cols && cols!=='*' ? Object.fromEntries(cols.split(',').filter(k=>k in row).map(k=>[k,row[k]])) : row;
      });
      return new Response(JSON.stringify(rows), {headers:{'content-range':`0-${Math.max(0,rows.length-1)}/${filtered.length}`}});
    }
    const payload = JSON.parse(init.body);
    if (payload.title === 'FORCE API FAILURE') return new Response('provider echoed secret-key', {status:500});
    if (method === 'POST') {
      if (state[table].some(row=>row[key]===payload[key])) return new Response('duplicate', {status:409});
      const saved = {...payload, ...(table!=='cohort_kickoff'?{created_at:'2026-09-14T12:00:00Z'}:{})};
      state[table].push(saved);
      return new Response(JSON.stringify([saved]));
    }
    if (method === 'PATCH') {
      const saved = filtered.map(row=>Object.assign(row,payload));
      return new Response(JSON.stringify(saved));
    }
    return new Response('unsupported',{status:405});
  };
  return {state,requests,fetch};
}
export async function httpFixture() {
  const mock=mockApi();
  const server=createServer(async(req,res)=> {
    let body=''; for await(const chunk of req) body+=chunk;
    const response=await mock.fetch(`http://127.0.0.1${req.url}`, {method:req.method,body:body||undefined,headers:req.headers});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {...mock, url:`http://127.0.0.1:${server.address().port}`, close:()=>new Promise(resolve=>server.close(resolve))};
}
