import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../dist/server.js';
await createServer({supabaseUrl:process.env.FIXTURE_URL,serviceKey:'fixture-key',writesEnabled:false,auditPath:'/nonexistent/unused'}).connect(new StdioServerTransport());
