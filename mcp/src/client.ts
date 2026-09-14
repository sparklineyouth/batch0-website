import type { Config } from './config.js';
import type { Table } from './schemas.js';

export type Row = Record<string, unknown>;
export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}
export class Batch0Client {
  constructor(readonly config: Config, private readonly requestFetch: typeof fetch = fetch) {}
  async request(path: string, init: RequestInit = {}): Promise<{ response: Response; data: unknown }> {
    let response: Response;
    try {
      response = await this.requestFetch(`${this.config.supabaseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: { apikey: this.config.serviceKey, Authorization: `Bearer ${this.config.serviceKey}`, 'Content-Type': 'application/json', ...init.headers },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError('The Batch0 data request failed or timed out. Check connectivity and retry reads. Before retrying writes, inspect the affected record and audit trail.');
    }
    const body = await response.text();
    if (!response.ok) {
      // Raw provider bodies can echo supplied content or credentials. Keep errors actionable without reflecting them.
      const hint = response.status === 401 || response.status === 403 ? 'Check the service key and project permissions.' : response.status === 404 ? 'Check the table/bucket and apply the repository migrations if needed.' : response.status === 409 ? 'A row or object with this identity already exists; read it before retrying.' : response.status === 429 ? 'Rate limited; wait and retry reads. Inspect before retrying writes.' : 'Check the database schema and input; inspect the affected record before retrying a write.';
      throw new ApiError(`Batch0 API returned HTTP ${response.status}. ${hint}`, response.status);
    }
    let data: unknown = null;
    if (body) {
      try { data = JSON.parse(body) as unknown; } catch { throw new ApiError('Batch0 returned an invalid JSON response.'); }
    }
    return { response, data };
  }
  async list(table: Table, params: URLSearchParams): Promise<{ rows: Row[]; total: number | null }> {
    const { response, data } = await this.request(`/rest/v1/${table}?${params}`, { headers: { Prefer: 'count=exact' } });
    if (!Array.isArray(data) || !data.every(item => item && typeof item === 'object' && !Array.isArray(item))) throw new ApiError('Batch0 returned unexpected row data.');
    const count = response.headers.get('content-range')?.split('/')[1];
    return { rows: data as Row[], total: count && /^\d+$/.test(count) ? Number(count) : null };
  }
  async get(table: Table, id: string, columns: string): Promise<Row | null> {
    const { rows } = await this.list(table, new URLSearchParams({ select: columns, [table === 'cohort_kickoff' ? 'cohort_id' : 'id']: `eq.${id}`, limit: '1' }));
    return rows[0] ?? null;
  }
  async save(table: Table, record: Row, existing: Row | null): Promise<Row> {
    const params = new URLSearchParams({ select: '*' });
    if (existing) {
      const key = table === 'cohort_kickoff' ? 'cohort_id' : 'id';
      params.set(key, `eq.${String(record[key])}`);
      if (typeof existing.updated_at === 'string') params.set('updated_at', `eq.${existing.updated_at}`);
    }
    const { data } = await this.request(`/rest/v1/${table}?${params}`, {
      method: existing ? 'PATCH' : 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(record),
    });
    if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') throw new ApiError('Write returned no single row. It may have conflicted with another update; inspect the record before retrying.');
    return data[0] as Row;
  }
}
