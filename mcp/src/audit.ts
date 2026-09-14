import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants } from 'node:fs';

export async function appendAudit(path: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
}
