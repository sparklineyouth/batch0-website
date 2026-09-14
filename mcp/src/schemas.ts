import { z } from 'zod';

export const tableSchema = z.enum(['cohorts', 'modules', 'lessons', 'resources', 'events', 'cohort_kickoff']);
export type Table = z.infer<typeof tableSchema>;
export const writableTableSchema = z.enum(['modules', 'lessons', 'resources']);
export type WritableTable = z.infer<typeof writableTableSchema>;
const uuid = z.uuid();
const title = z.string().trim().min(1).max(240);
const description = z.string().max(100_000).nullable().optional();
const path = z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.includes('..') && !value.includes('://') && !/[\x00-\x1f\\]/.test(value), 'Use a relative storage path with no traversal or URL');
const url = z.url().max(2048).refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }, 'Use an HTTPS URL without credentials');
const common = { id: uuid.describe('Stable UUID chosen by the caller; repeated inserts cannot create duplicate rows.'), title };
export const rowSchemas = {
  modules: z.object({ ...common, cohort_id: uuid, week: z.number().int().min(1).max(52), summary: description, position: z.number().int().min(0).max(1000) }).strict(),
  lessons: z.object({ ...common, module_id: uuid, description, video_path: path.nullable().optional(), video_url: url.nullable().optional(), duration_seconds: z.number().int().min(0).max(86400).nullable().optional(), materials: z.array(z.object({ title, path }).strict()).max(30).optional(), position: z.number().int().min(0).max(1000) }).strict(),
  resources: z.object({ ...common, cohort_id: uuid.nullable(), category: z.string().trim().min(1).max(80), description, storage_path: path.nullable().optional(), external_url: url.nullable().optional(), size_bytes: z.number().int().min(0).max(1_000_000_000).nullable().optional(), mime_type: z.string().max(120).nullable().optional(), pre_cohort: z.boolean() }).strict(),
};
export const listSchema = z.object({
  table: tableSchema,
  cohort_id: uuid.optional().describe('Filter modules, resources, or events by exact cohort; for global resources/events use global_only.'),
  module_id: uuid.optional().describe('Filter lessons by exact module UUID.'),
  global_only: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(100_000).default(0),
  include_content: z.boolean().default(false).describe('Return full authored content instead of compact titles and metadata. Use small pages for long lessons.'),
}).strict();
export const getSchema = z.object({ table: tableSchema, id: uuid }).strict();
export const statusSchema = z.object({}).strict();
const change = z.discriminatedUnion('table', [
  z.object({ table: z.literal('modules'), record: rowSchemas.modules, expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ table: z.literal('lessons'), record: rowSchemas.lessons, expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ table: z.literal('resources'), record: rowSchemas.resources, expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
]);
export const upsertSchema = z.object({
  changes: z.array(change).min(1).max(25).describe('Up to 25 inserts/updates. Put new modules before lessons that reference them. Existing rows require the hash from batch0_get_record.'),
  dry_run: z.boolean().default(true).describe('Preview without writes. Set false only after reviewing the planned changes; the process must also enable writes.'),
  reason: z.string().trim().min(8).max(400).describe('Human-readable reason recorded in the private local audit trail.'),
}).strict();
export type Change = z.infer<typeof change>;
export const uploadSchema = z.object({
  bucket: z.enum(['course-materials', 'resources']),
  path: path.refine(value => (value.startsWith('mcp/') || value.startsWith('course-launch/')) && /\.(md|txt|csv|json|html|pdf)$/.test(value), 'MCP uploads must use mcp/ or course-launch/ and end in .md, .txt, .csv, .json, .html, or .pdf'),
  text: z.string().min(1).max(200_000).optional().describe('Original UTF-8 teaching material; HTML must be static printable text/CSS with no active or fetching content. Use exactly one of text or pdf_base64. HTML is served as plain text by Supabase; use PDF for printable browser viewing.'),
  pdf_base64: z.string().min(1).max(2_796_204).optional().describe('Standard padded base64 of an original PDF, at most 2 MiB decoded. Only valid with a .pdf path and without text. Not a URL or file path.'),
  dry_run: z.boolean().default(true),
  reason: z.string().trim().min(8).max(400),
}).strict().superRefine((value, ctx) => {
  if ((value.text === undefined) === (value.pdf_base64 === undefined)) ctx.addIssue({ code: 'custom', message: 'Supply exactly one of text or pdf_base64.' });
  if (value.path.endsWith('.pdf') !== (value.pdf_base64 !== undefined)) ctx.addIssue({ code: 'custom', message: 'PDF bytes require a .pdf path; text requires a text/HTML path.' });
});

const safeHref = z.string().max(2048).refine(value => /^\/(?!\/)[^\s\\]*$/.test(value) || (value.startsWith('https://') && url.safeParse(value).success), 'Use a site-relative path or HTTPS URL');
export const kickoffSchema = z.object({
  cohort_id: uuid,
  record: z.object({
    headline: z.string().trim().max(500).nullable().optional(),
    intro: z.string().max(5000).nullable().optional(),
    time_label: z.string().max(500).nullable().optional(),
    location_label: z.string().max(500).nullable().optional(),
    join_url: url.nullable().optional(),
    agenda: z.array(z.object({title: z.string().trim().min(1).max(500), body: z.string().max(5000)}).strict()).max(12).nullable().optional(),
    checklist: z.array(z.object({label: z.string().trim().min(1).max(500), href: safeHref}).strict()).max(12).nullable().optional(),
    note: z.string().max(5000).nullable().optional(),
  }).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one kickoff field'),
  expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dry_run: z.boolean().default(true),
  reason: z.string().trim().min(8).max(400),
}).strict();
