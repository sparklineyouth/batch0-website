#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { Batch0Client } from './client.js';
import { Operations, invoke, definitions } from './operations.js';

const [name, file] = process.argv.slice(2);
if (!name || name === '--help') {
  process.stdout.write('Usage: node mcp/dist/cli.js TOOL [INPUT_JSON_FILE|-]\nUse - to read JSON from stdin; omit the input for {}.\nTools: ' + Object.keys(definitions).join(', ') + '\n');
} else {
  try {
    let source = '{}';
    if (file === '-') { source = ''; for await (const chunk of process.stdin) source += String(chunk); }
    else if (file) source = await readFile(file, 'utf8');
    if (Buffer.byteLength(source) > 3_000_000) throw new Error('Input JSON exceeds 3 MB. Split the request.');
    const result = await invoke(new Operations(new Batch0Client(loadConfig())), name, JSON.parse(source) as unknown);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.success === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Batch0 operation failed');
    process.exitCode = 1;
  }
}
