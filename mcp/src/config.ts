import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface Config {
  supabaseUrl: string;
  serviceKey: string;
  writesEnabled: boolean;
  auditPath: string;
}
export function loadConfig(): Config {
  const envPath = process.env.BATCH0_ENV_FILE ?? fileURLToPath(new URL('../../.env.local', import.meta.url));
  try { loadEnvFile(envPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load the Batch0 environment file. Check its permissions.');
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) throw new Error('Configure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the repository .env.local or BATCH0_ENV_FILE.');
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The Supabase URL must be an HTTPS project origin on supabase.co. No custom credential destinations are allowed.');
  }
  return {
    supabaseUrl: url.origin,
    serviceKey,
    writesEnabled: process.env.BATCH0_MCP_ALLOW_WRITES === 'true',
    auditPath: resolve(process.env.BATCH0_MCP_AUDIT_PATH ?? fileURLToPath(new URL('../.audit/operations.jsonl', import.meta.url))),
  };
}
