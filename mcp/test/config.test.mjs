import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const moduleUrl=new URL('../dist/config.js',import.meta.url).href;
const source=`import {loadConfig} from ${JSON.stringify(moduleUrl)};try { const c=loadConfig(); console.log(JSON.stringify({host:new URL(c.supabaseUrl).hostname,writes:c.writesEnabled})); } catch (e) { console.error(e.message); process.exitCode=1; }`;
function run(url, write='false'){return spawnSync(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,BATCH0_ENV_FILE:'/nonexistent/batch0-test-env',NEXT_PUBLIC_SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'do-not-echo-this-key',BATCH0_MCP_ALLOW_WRITES:write},encoding:'utf8'});}
test('production config permits only HTTPS Supabase project origins and literal write opt-in',()=>{
  for(const url of ['https://attacker.example','http://valid.supabase.co','https://valid.supabase.co@attacker.example','https://valid.supabase.co/path','https://valid.supabase.co?redirect=bad','https://valid.supabase.co/#bad']){const r=run(url);assert.equal(r.status,1);assert.ok(!r.stderr.includes('do-not-echo-this-key'));}
  assert.equal(JSON.parse(run('https://valid.supabase.co','TRUE').stdout).writes,false);
  assert.equal(JSON.parse(run('https://valid.supabase.co','true').stdout).writes,true);
});
