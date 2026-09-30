import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BSON, Double, Int32, ObjectId, type Db, type Document } from 'mongodb';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DB, type PerformanceCollection } from './performance-profile.js';

interface BsonSchema { bsonType: string | string[]; properties?: Record<string, BsonSchema>; required?: string[] }
const schemaFile = new URL('../../vendor/spec/performance-source.schema.json', import.meta.url);
const schemaPack = JSON.parse(readFileSync(schemaFile, 'utf8')) as {
  collections: Record<string, { jsonSchema: BsonSchema }>;
};
export function sourceSchema(collection: PerformanceCollection): BsonSchema {
  return schemaPack.collections[`${PERFORMANCE_DB}.${collection}`]!.jsonSchema;
}

/** Only tolerate the supplied final-array trailing comma; no eval/JSON5. */
export function parseMockRecords(text: string): unknown[] {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch {
    try { value = JSON.parse(text.replace(/^\uFEFF/, '').replace(/,\s*\]\s*$/, ']')); }
    catch { throw new Error('Invalid mock JSON'); }
  }
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.length > 10000) throw new Error('Invalid mock record count');
  return rows;
}

const descriptive = new Set(['agent_name', 'agentName', 'branch_name', 'branch_code', 'region_name', 'agentBranchName', 'agentRegionName']);
function normalize(value: unknown, schema: BsonSchema, path: string): unknown {
  const types = [schema.bsonType].flat();
  if ((value === null || value === 'null') && types.includes('null')) return null;
  if (types.includes('object')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid object at ${path}`);
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      let v = input[key];
      if (v === undefined && (key === 'schemeType' || key === 'scheme_type' || key === 'agentRefererAgentId' || key === 'as_on_month_day')) v = null;
      if (v === undefined) {
        if (schema.required?.includes(key)) throw new Error(`Missing field at ${path}.${key}`);
        continue;
      }
      if (descriptive.has(key)) v = 'Redacted mock label';
      result[key] = normalize(v, child, `${path}.${key}`);
    }
    return result;
  }
  if (types.includes('objectId')) {
    const v = typeof value === 'object' && value !== null ? (value as { $oid?: unknown }).$oid : value;
    if (typeof v !== 'string' || !/^[a-f0-9]{24}$/i.test(v)) throw new Error(`Invalid ObjectId at ${path}`);
    return new ObjectId(v);
  }
  if (types.includes('date')) {
    const v = typeof value === 'object' && value !== null ? (value as { $date?: unknown }).$date : value;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error(`Invalid date at ${path}`);
    return new Date(v);
  }
  if (types.includes('string') && typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (types.includes('int') && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return new Int32(value);
    if (types.includes('double')) return new Double(value);
  }
  throw new Error(`Invalid BSON type at ${path}`);
}

export function normalizeMockRecord(collection: PerformanceCollection, input: unknown): Document {
  const document = normalize(input, sourceSchema(collection), collection) as Document;
  const p = document.period;
  const year = Number(p.year), month = Number(p.month);
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || month < 1 || month > 12) throw new Error('Invalid reporting period');
  if (p.quarter !== `Q${Math.ceil(month / 3)}` || ![`${year}${String(month).padStart(2, '0')}`, `${year}-${String(month).padStart(2, '0')}`].includes(p.yyyymm)) throw new Error('Inconsistent reporting period');
  const watermark = document.asOnDate instanceof Date ? document.asOnDate.toISOString() : String(document.asOnDate);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(watermark) || !Number.isFinite(Date.parse(watermark))) throw new Error('Invalid source watermark');
  if (p.asOnMonthDay !== undefined) {
    const day = Number(p.asOnMonthDay);
    if (!Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('Invalid reporting day');
  }
  return document;
}

function stable(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(BSON.EJSON.serialize(value, { relaxed: false })));
}
export const documentFingerprint = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
export type MockImport = Record<PerformanceCollection, Document[]>;

/** Required/type/enum sets are unordered; additionalProperties defaults to true. */
export function equivalentValidator(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown, keyword = ''): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(item => canonical(item));
      return ['required', 'bsonType', 'enum'].includes(keyword) ? items.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : items;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !(key === 'additionalProperties' && item === true))
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([key, item]) => [key, canonical(item, key)]));
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Provision only these three schemas; refuse to change nonempty unrelated collections. */
export async function provisionPerformance(db: Db): Promise<void> {
  if (db.databaseName !== PERFORMANCE_DB) throw new Error('Invalid Performance provisioning target');
  const existing = await db.listCollections({}, { nameOnly: false }).toArray();
  for (const name of PERFORMANCE_COLLECTIONS) {
    const info = existing.find(collection => collection.name === name);
    const validator = { $jsonSchema: sourceSchema(name) };
    const current = info?.options?.validator;
    if (current && Object.keys(current).length && !equivalentValidator(current, validator)) throw new Error('Target has a different validator');
    if (info && (!current || !Object.keys(current).length) && await db.collection(name).countDocuments() > 0) throw new Error('Refusing to add a validator to unrelated nonempty data');
  }
  for (const name of PERFORMANCE_COLLECTIONS) {
    const validator = { $jsonSchema: sourceSchema(name) };
    if (existing.some(collection => collection.name === name)) await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    else await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    await db.collection(name).createIndex({ id: 1 }, { unique: true, name: 'uq_mock_source_id' });
    await db.collection(name).createIndex({ agentId: 1, agentAggregation: 1, entity: 1,
      'period.year': -1, 'period.month': -1 }, { name: 'ix_mock_performance_read' });
  }
}

/** Read-only conflict preflight; never overwrite existing source records. */
export async function inspectImport(db: Db, rows: MockImport) {
  if (db.databaseName !== PERFORMANCE_DB) throw new Error('Import target must be the named development database');
  const pending: MockImport = { my_production: [], my_mapa: [], my_persistency: [] };
  const counts: Record<string, { input: number; insert: number; unchanged: number }> = {};
  for (const name of PERFORMANCE_COLLECTIONS) {
    const ids = new Set<string>(), keys = new Set<string>();
    for (const row of rows[name]) {
      const id = String(row._id);
      if (ids.has(id) || keys.has(row.id)) throw new Error(`Duplicate input key in ${name}`);
      ids.add(id); keys.add(row.id);
      const existing = await db.collection(name).find({ $or: [{ _id: row._id }, { id: row.id }] }, { promoteValues: false }).toArray();
      if (!existing.length) pending[name].push(row);
      else if (existing.length !== 1 || documentFingerprint(existing[0]) !== documentFingerprint(row)) throw new Error(`Conflicting existing record in ${name}; import aborted`);
    }
    counts[name] = { input: rows[name].length, insert: pending[name].length, unchanged: rows[name].length - pending[name].length };
  }
  return { pending, counts };
}