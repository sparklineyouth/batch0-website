// A completely isolated read-only MCP fixture for evaluating an assistant.
// No production configuration, keys, or network destination is loaded.
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../dist/server.js';
import { httpFixture } from '../test/mock.mjs';
const fixture=await httpFixture();Object.assign(fixture.state,JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8')));
const server=createServer({supabaseUrl:fixture.url,serviceKey:'fixture-only',writesEnabled:false,auditPath:'/unused'});
process.stdin.on('end',()=>{void fixture.close();});
await server.connect(new StdioServerTransport());
