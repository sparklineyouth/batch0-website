#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

if (process.argv.includes('--help')) {
  process.stdout.write('Batch0 MCP server (local stdio)\nReads ../.env.local automatically. BATCH0_ENV_FILE overrides it.\nRead-only by default. BATCH0_MCP_ALLOW_WRITES=true enables explicit non-dry-run content writes.\nSee docs/mcp.md for tools, controls, and CLI usage.\n');
} else {
  try { await createServer(loadConfig()).connect(new StdioServerTransport()); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Batch0 MCP startup failed'); process.exitCode = 1; }
}
