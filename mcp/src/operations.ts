import { createHash, randomUUID } from 'node:crypto';
import { Batch0Client, type Row } from './client.js';
import { validatePrintableHtml } from './html.js';
import { appendAudit } from './audit.js';
import { getSchema, listSchema, statusSchema, upsertSchema, uploadSchema, kickoffSchema, type Table, type Change } from './schemas.js';

export const fullColumns: Record<Table, string> = {
  cohort_kickoff: 'cohort_id,headline,intro,time_label,location_label,join_url,agenda,checklist,note,updated_at',
  cohorts: 'id,name,starts_on,ends_on,capacity,status,price_cents,created_at',
  modules: 'id,cohort_id,week,title,summary,position,created_at',
  lessons: 'id,module_id,title,description,video_path,video_url,duration_seconds,materials,position,created_at',
  resources: 'id,cohort_id,category,title,description,storage_path,external_url,size_bytes,mime_type,pre_cohort,created_at,updated_at',
  events: 'id,cohort_id,type,title,description,starts_at,ends_at,location,zoom_url,recording_url,visibility,live_mode,daily_room_name,daily_room_url,created_at,updated_at',
};
const compactColumns: Record<Table, string> = {
  ...fullColumns,
  modules: 'id,cohort_id,week,title,position',
  lessons: 'id,module_id,title,duration_seconds,position',
  resources: 'id,cohort_id,category,title,external_url,storage_path,pre_cohort',
  events: 'id,cohort_id,type,title,starts_at,ends_at,visibility,live_mode,zoom_url,daily_room_name',
};
const order: Record<Table, string> = { cohort_kickoff: 'updated_at.desc,cohort_id', cohorts: 'starts_on.desc.nullslast,id', modules: 'week,position,id', lessons: 'position,id', resources: 'category,title,id', events: 'starts_at.desc,id' };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export class Operations {
  constructor(readonly client: Batch0Client) {}
  async status(input: unknown): Promise<Row> {
    statusSchema.parse(input);
    const [cohorts, ...counts] = await Promise.all([
      this.client.list('cohorts', new URLSearchParams({ select: fullColumns.cohorts, order: order.cohorts, limit: '100' })),
      ...(['modules', 'lessons', 'resources', 'events'] as const).map(async table => ({ table, ...(await this.client.list(table, new URLSearchParams({ select: 'id', limit: '1' }))) })),
    ]);
    return { connected: true, project_host: new URL(this.client.config.supabaseUrl).hostname, writes_enabled: this.client.config.writesEnabled, cohorts: cohorts.rows, cohorts_total: cohorts.total, counts: Object.fromEntries(counts.map(c => [c.table, c.total])), capabilities: ['read_course', 'preview_content', 'upsert_content', 'upload_original_text_materials'], content_cache_ttl_seconds: 60, note: 'Content-only integration. No payments, users, email, advertisements, arbitrary SQL, or hosted-room management.' };
  }
  async list(input: unknown): Promise<Row> {
    const p = listSchema.parse(input);
    if (p.cohort_id && !['modules', 'resources', 'events', 'cohort_kickoff'].includes(p.table)) throw new Error('cohort_id filters only modules/resources/events. For lessons, list cohort modules and filter lessons by module_id.');
    if (p.module_id && p.table !== 'lessons') throw new Error('module_id filters only lessons.');
    if (p.global_only && !['modules', 'resources', 'events', 'cohort_kickoff'].includes(p.table)) throw new Error('global_only applies only to modules/resources/events.');
    if (p.global_only && p.cohort_id) throw new Error('Choose cohort_id or global_only, not both.');
    const params = new URLSearchParams({ select: p.include_content ? fullColumns[p.table] : compactColumns[p.table], order: order[p.table], offset: String(p.offset), limit: String(p.limit) });
    if (p.cohort_id) params.set('cohort_id', `eq.${p.cohort_id}`);
    if (p.module_id) params.set('module_id', `eq.${p.module_id}`);
    if (p.global_only) params.set('cohort_id', 'is.null');
    const { rows, total } = await this.client.list(p.table, params);
    const next = rows.length === p.limit && (total === null || p.offset + rows.length < total) ? p.offset + rows.length : null;
    return { table: p.table, rows: rows.map(row => p.include_content ? { record: row, hash: fingerprint(row) } : row), total, next_offset: next, full_content: p.include_content };
  }
  async get(input: unknown): Promise<Row> {
    const { table, id } = getSchema.parse(input);
    const record = await this.client.get(table, id, fullColumns[table]);
    return { table, record, hash: record ? fingerprint(record) : null };
  }
  async upsert(input: unknown): Promise<Row> {
    const p = upsertSchema.parse(input);
    if (!p.dry_run && !this.client.config.writesEnabled) throw new Error('Writes are disabled. Review a dry run, then start with BATCH0_MCP_ALLOW_WRITES=true to apply explicitly.');
    const identities = new Set<string>();
    const virtual = new Map<string, Row>();
    const plans: { change: Change; before: Row | null; after: Row; changed_fields: string[]; operation: string }[] = [];
    for (const change of p.changes) {
      const identity = `${change.table}:${change.record.id}`;
      if (identities.has(identity)) throw new Error(`Duplicate record identity in one request: ${identity}.`);
      identities.add(identity);
      const before = await this.client.get(change.table, change.record.id, fullColumns[change.table]);
      if (before && (!change.expected_hash || fingerprint(before) !== change.expected_hash)) throw new Error(`Record ${identity} exists or changed. Read it with batch0_get_record and supply its current expected_hash.`);
      if (!before && change.expected_hash) throw new Error(`Record ${identity} no longer exists. Preview it as an insert without expected_hash.`);
      const record: Row = change.record;
      const parentTable = change.table === 'lessons' ? 'modules' : 'cohorts';
      const parentId = change.table === 'lessons' ? record.module_id : record.cohort_id;
      const scopeKey = change.table === 'lessons' ? 'module_id' : 'cohort_id';
      if (before && before[scopeKey] !== record[scopeKey]) throw new Error(`Moving ${identity} across a cohort/module is unsupported; preserve its existing scope.`);
      if (typeof parentId === 'string') {
        const parent = virtual.get(`${parentTable}:${parentId}`) ?? await this.client.get(parentTable, parentId, fullColumns[parentTable]);
        if (!parent) throw new Error(`${parentTable} parent ${parentId} does not exist. Put new modules before their lessons.`);
      }
      if (!before) {
        const match = new URLSearchParams({ select: 'id,title', title: `eq.${record.title}`, [scopeKey]: parentId === null ? 'is.null' : `eq.${parentId}`, limit: '1' });
        const duplicate = await this.client.list(change.table, match);
        const localDuplicate = [...virtual.entries()].some(([key, value]) => key.startsWith(`${change.table}:`) && value.title === record.title && value[scopeKey] === record[scopeKey]);
        if (duplicate.rows.length || localDuplicate) throw new Error(`A ${change.table} record with this title already exists in the same scope. Read and update that record instead of duplicating it.`);
      }
      const after = { ...before, ...record };
      if (change.table === 'resources' && !after.storage_path && !after.external_url) throw new Error('A resource requires storage_path or external_url. Upload an original material first or supply a verified HTTPS source.');
      const changed_fields = Object.keys(record).filter(key => JSON.stringify(canonical(record[key])) !== JSON.stringify(canonical(before?.[key])));
      plans.push({ change, before, after, changed_fields, operation: before ? (changed_fields.length ? 'update' : 'unchanged') : 'insert' });
      virtual.set(identity, after);
    }
    const summary = plans.map(plan => ({ table: plan.change.table, id: plan.change.record.id, title: plan.change.record.title, operation: plan.operation, changed_fields: plan.changed_fields, before_hash: plan.before ? fingerprint(plan.before) : null, proposed_record: plan.change.record }));
    if (p.dry_run) return { dry_run: true, validated: true, changes: summary, note: 'No rows or audit entries written. Applies are sequential, not a transaction; failures report any completed rows.' };
    const operationId = randomUUID();
    await appendAudit(this.client.config.auditPath, { phase: 'intent', operation_id: operationId, action: 'content_upsert', reason: p.reason, changes: plans.map(plan => ({ table: plan.change.table, id: plan.change.record.id, operation: plan.operation, before_hash: plan.before ? fingerprint(plan.before) : null, after_hash: fingerprint(plan.after) })) });
    const applied: Row[] = [];
    try {
      for (const plan of plans) {
        if (plan.operation === 'unchanged') { applied.push({ table: plan.change.table, id: plan.change.record.id, operation: 'unchanged', hash: fingerprint(plan.before) }); continue; }
        const current = await this.client.get(plan.change.table, plan.change.record.id, fullColumns[plan.change.table]);
        if (fingerprint(current) !== fingerprint(plan.before)) throw new Error(`Record ${plan.change.table}:${plan.change.record.id} changed after preview; refresh before retrying.`);
        const saved = await this.client.save(plan.change.table, plan.change.record, current);
        const visibleSaved = Object.fromEntries(fullColumns[plan.change.table].split(',').filter(key => key in saved).map(key => [key, saved[key]]));
        const result = { table: plan.change.table, id: saved.id, operation: plan.operation, hash: fingerprint(visibleSaved) };
        applied.push(result);
        await appendAudit(this.client.config.auditPath, { phase: 'applied', operation_id: operationId, ...result });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown failure';
      try { await appendAudit(this.client.config.auditPath, { phase: 'failed', operation_id: operationId, applied, message }); } catch { /* Preserve the original result and successful row IDs. */ }
      return { success: false, operation_id: operationId, applied, error: message, next_step: 'Read affected records before retrying; prior rows may already be applied.' };
    }
    await appendAudit(this.client.config.auditPath, { phase: 'complete', operation_id: operationId, count: applied.length });
    return { success: true, dry_run: false, operation_id: operationId, applied, content_cache_ttl_seconds: 60 };
  }
  async kickoff(input: unknown): Promise<Row> {
    const p = kickoffSchema.parse(input);
    if (!p.dry_run && !this.client.config.writesEnabled) throw new Error('Writes are disabled. Review the dry run and enable BATCH0_MCP_ALLOW_WRITES=true to apply.');
    const parent = await this.client.get('cohorts', p.cohort_id, fullColumns.cohorts);
    if (!parent) throw new Error('The kickoff cohort does not exist.');
    const before = await this.client.get('cohort_kickoff', p.cohort_id, fullColumns.cohort_kickoff);
    if (before && (!p.expected_hash || fingerprint(before) !== p.expected_hash)) throw new Error('Kickoff content exists or changed. Read cohort_kickoff with batch0_get_record, using the cohort UUID as id, and supply its current expected_hash.');
    if (!before && p.expected_hash) throw new Error('Kickoff content no longer exists; preview as an insert without expected_hash.');
    const record = { cohort_id: p.cohort_id, ...p.record };
    if (p.dry_run) return { dry_run: true, operation: before ? 'update' : 'insert', before_hash: before ? fingerprint(before) : null, proposed_record: record };
    const operationId = randomUUID();
    await appendAudit(this.client.config.auditPath, { phase: 'intent', operation_id: operationId, action: 'kickoff_save', cohort_id: p.cohort_id, reason: p.reason, before_hash: before ? fingerprint(before) : null, after_hash: fingerprint(record) });
    const current = await this.client.get('cohort_kickoff', p.cohort_id, fullColumns.cohort_kickoff);
    if (fingerprint(current) !== fingerprint(before)) throw new Error('Kickoff changed after preview; read it before retrying.');
    const saved = await this.client.save('cohort_kickoff', { ...record, updated_at: new Date().toISOString() }, before);
    await appendAudit(this.client.config.auditPath, { phase: 'complete', operation_id: operationId, action: 'kickoff_save', cohort_id: p.cohort_id, hash: fingerprint(saved) });
    return { success: true, dry_run: false, operation_id: operationId, record: saved, hash: fingerprint(saved) };
  }
  async upload(input: unknown): Promise<Row> {
    const p = uploadSchema.parse(input);
    if (p.path.endsWith('.html')) validatePrintableHtml(p.text);
    const size = Buffer.byteLength(p.text, 'utf8');
    if (size > 400_000) throw new Error('Material exceeds 400,000 UTF-8 bytes. Split it into smaller files.');
    const sha256 = createHash('sha256').update(p.text).digest('hex');
    const result = { bucket: p.bucket, path: p.path, size_bytes: size, sha256 };
    if (p.dry_run) return { dry_run: true, ...result };
    if (!this.client.config.writesEnabled) throw new Error('Writes are disabled. Start with BATCH0_MCP_ALLOW_WRITES=true after reviewing the upload.');
    const operationId = randomUUID();
    await appendAudit(this.client.config.auditPath, { phase: 'intent', operation_id: operationId, action: 'material_upload', reason: p.reason, ...result });
    const ext = p.path.split('.').at(-1);
    const mime = ext === 'html' ? 'text/html' : ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'md' ? 'text/markdown' : 'text/plain';
    await this.client.request(`/storage/v1/object/${p.bucket}/${p.path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': `${mime}; charset=utf-8`, 'x-upsert': 'false' }, body: p.text });
    await appendAudit(this.client.config.auditPath, { phase: 'complete', operation_id: operationId, action: 'material_upload', ...result });
    return { success: true, dry_run: false, operation_id: operationId, ...result, mime_type: mime, note: 'Private storage object. Reference this path in lesson materials or a resource; this tool never makes it public.' };
  }
}

export function resultEnvelope(value: Row): { content: { type: 'text'; text: string }[]; structuredContent: Row; isError?: boolean } {
  const safe = value;
  const text = JSON.stringify(safe);
  if (text.length > 180_000) throw new Error('Result is too large. Use a smaller list limit or batch of changes; no result was silently truncated.');
  return { content: [{ type: 'text', text }], structuredContent: safe, ...(safe.success === false ? { isError: true } : {}) };
}
export const definitions = {
  batch0_save_kickoff: { title: 'Preview or save kickoff content', schema: kickoffSchema, method: 'kickoff', read: false, description: 'Save one cohort kickoff page with strict links, agenda, and checklist fields. Defaults to dry run. Existing content requires the hash from batch0_get_record on table cohort_kickoff (id is the cohort UUID). Never creates meetings or sends messages.' },
  batch0_status: { title: 'Batch0 platform status', schema: statusSchema, method: 'status', read: true, description: 'Check database access, active/upcoming cohorts, content counts, and whether this process can write. No student or payment data is returned.' },
  batch0_list_records: { title: 'List Batch0 content', schema: listSchema, method: 'list', read: true, description: 'Paginated read of cohorts, modules, lessons, resources, or events. Returns rows, total, and next_offset. Use include_content for full records plus update hashes.' },
  batch0_get_record: { title: 'Read one Batch0 record', schema: getSchema, method: 'get', read: true, description: 'Read a complete allowlisted content record and its current SHA-256 hash. Use that hash as expected_hash for an intentional update.' },
  batch0_upsert_content: { title: 'Preview or apply Batch0 content', schema: upsertSchema, method: 'upsert', read: false, description: 'Validate or apply up to 25 modules, lessons, and resources. Defaults to dry_run=true. Stable UUIDs, existing-row hashes, strict fields, reference checks, and local audit guard writes. Sequential, not transactional; never deletes or sends notifications.' },
  batch0_upload_material: { title: 'Upload original teaching material', schema: uploadSchema, method: 'upload', read: false, description: 'Preview or upload original UTF-8 Markdown, text, CSV, JSON, or strictly static printable HTML to private course-materials/resources under mcp/ or course-launch/. No overwrites or remote downloads. Defaults to dry run. Return includes path, bytes, and digest.' },
} as const;
export type ToolName = keyof typeof definitions;
export async function invoke(operations: Operations, name: string, input: unknown): Promise<Row> {
  if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown tool. Available tools: ${Object.keys(definitions).join(', ')}`);
  return operations[definitions[name as ToolName].method](input);
}
