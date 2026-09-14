import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Batch0Client } from './client.js';
import type { Config } from './config.js';
import { definitions, Operations, invoke, resultEnvelope } from './operations.js';

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: 'batch0-mcp-server', version: '1.0.0' });
  const operations = new Operations(new Batch0Client(config));
  for (const [name, definition] of Object.entries(definitions)) {
    server.registerTool(name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema,
      outputSchema: z.record(z.string(), z.unknown()),
      annotations: { readOnlyHint: definition.read, destructiveHint: !definition.read, idempotentHint: definition.read, openWorldHint: false },
    }, async (input: unknown) => {
      try { return resultEnvelope(await invoke(operations, name, input)); }
      catch (error) {
        const message = error instanceof z.ZodError ? `Invalid input: ${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` : error instanceof Error ? error.message : 'Unexpected Batch0 operation failure';
        return { content: [{ type: 'text' as const, text: message }], isError: true };
      }
    });
  }
  return server;
}
