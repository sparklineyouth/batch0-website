import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { httpFixture } from './mock.mjs';
test('real SDK stdio client discovers schemas, calls status and rejects unknown tables',async t=>{
  const fixture=await httpFixture();
  const client=new Client({name:'batch0-protocol-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixture-server.mjs',import.meta.url))],env:{PATH:process.env.PATH,FIXTURE_URL:fixture.url},stderr:'pipe'});
  t.after(async()=>{await client.close();await fixture.close();});
  await client.connect(transport);
  const listed=await client.listTools();assert.equal(listed.tools.length,6);assert.equal(listed.tools.find(x=>x.name==='batch0_status').annotations.readOnlyHint,true);
  const status=await client.callTool({name:'batch0_status',arguments:{}});assert.equal(status.structuredContent.connected,true);assert.equal(status.structuredContent.writes_enabled,false);
  const before=fixture.requests.length;
  const bad=await client.callTool({name:'batch0_list_records',arguments:{table:'profiles'}});assert.equal(bad.isError,true);assert.equal(fixture.requests.length,before);
});
