import { afterEach, describe, expect, it, vi } from 'vitest';
import { BSON, Decimal128, type Db, type Document } from 'mongodb';
import { buildApp } from '../src/app.js';
import { PerformanceSource } from '../src/data/performance-source.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DB, performanceProfile, type PerformanceCollection } from '../src/data/performance-profile.js';
import { documentFingerprint, equivalentValidator, inspectImport, normalizeMockRecord, parseMockRecords, sourceSchema, type MockImport } from '../src/data/performance-import.js';
import { sourceMoney } from '../src/lib/money.js';
import { createSource } from '../src/data/source.js';
import type { AgentRecord } from '../src/data/registry.js';
import type { Lens } from '../src/data/values.js';

process.env.MONGODB_URI = '';
const lens: Lens = { period: 'YTD', businessLine: 'INSURANCE', basis: 'STANDARD', scope: 'SELF' };
const agent: AgentRecord = { agentId: 'MOCK_SELF', tenant: 'MY', level: 'P4', name: 'Mock' };
const leader: AgentRecord = { agentId: 'MOCK_GROUP', tenant: 'MY', level: 'P2', name: 'Mock' };
const other: AgentRecord = { agentId: 'MOCK_OTHER', tenant: 'MY', level: 'P2', name: 'Mock' };
const agents = new Map([agent, leader, other].map(a => [a.agentId, a]));
const team: Lens = { ...lens, scope: 'TEAM', teamView: 'GROUP' };
const period = { year: 2025, month: 5, quarter: 'Q2', yyyymm: '202505' };
const production: Document = { agent_id: agent.agentId, agent_aggregation: 'Personal', entity: 'PAMB', case_status: 'Collected',
  period, asOnDate: '2026-09-07T11:09:09Z', ptd: {
    tpc: { withoutRepricing: { ytd: 4538.76, mtd: 0 }, withRepricing: { ytd: 12668.720000000001, mtd: 8249.96 } },
    ptpc: { withoutRepricing: { ytd: 2329.38 } }, fyp: { ytd: 21678.39 },
    fyc: { ytd: null }, caseCount: { total: { ytd: 4, mtd: 0 } },
  } };
const mapa: Document = { agentId: leader.agentId, agentAggregation: 'Group', entity: 'PAMB',
  period: { ...period, asOnMonthDay: '28' }, asOnDate: new Date('2026-09-18T00:00:00Z'),
  ptd: { manpowerTotal: { ytd: 12 }, activityRatio: { ytd: 12 }, productivity: { ytd: 1 }, averageCaseSize: { ytd: 3922 }, newRecruits: { ytd: 0 } } };
const persistency: Document = { agentId: other.agentId, agentAggregation: 'Group', entity: 'PAMB', period,
  asOnDate: new Date('2026-09-07T00:00:00Z'), metrics: { ytd: { current_year_persistency: 1, first_year_persistency: 0.88, second_year_persistency: 0.79 }, bonus: { first_year_persistency: 10 } } };

function fakeDb(data: Partial<Record<PerformanceCollection, Document[]>> = {}, name = PERFORMANCE_DB) {
  const queried: string[] = [];
  const requests: Array<{ collection: string; query: Document; options: Document }> = [];
  const get = (row: Document, key: string) => key.split('.').reduce((v, part) => v?.[part], row);
  const matches = (row: Document, query: Document): boolean => Object.entries(query).every(([key, value]) => key === '$or'
    ? (value as Document[]).some(q => matches(row, q)) : String(get(row, key)) === String(value));
  const db = { databaseName: name, collection: (collection: PerformanceCollection) => {
    queried.push(collection);
    return { find: (query: Document, options: Document = {}) => {
      requests.push({ collection, query, options });
      let rows = (data[collection] ?? []).filter(row => matches(row, query));
      const cursor = {
        sort: (order: Document) => { rows.sort((a, b) => {
          for (const [key, direction] of Object.entries(order)) {
            const av = get(a, key), bv = get(b, key);
            if (av < bv) return -Number(direction);
            if (av > bv) return Number(direction);
          }
          return 0;
        }); return cursor; },
        limit: (n: number) => { rows = rows.slice(0, n); return cursor; },
        toArray: async () => rows,
      };
      return cursor;
    } };
  } } as unknown as Db;
  return { db, queried, requests };
}
const setup = () => {
  const { db, queried } = fakeDb({ my_production: [production], my_mapa: [mapa], my_persistency: [persistency] });
  return { source: new PerformanceSource(db, agents), queried };
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });

describe('three-collection Performance adapter', () => {
  it('AC-PA-DIRECT-01 rejects production, wrong database/country and missing identity config', () => {
    const env = { NODE_ENV: 'development', COUNTRY_CODE: 'MY', MONGODB_PERFORMANCE_DB: PERFORMANCE_DB, INSIGHTS_MOCK_AGENTS: '{"MOCK_SELF":"P4"}' };
    expect(performanceProfile(env).get('MOCK_SELF')?.level).toBe('P4');
    expect(() => performanceProfile({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => performanceProfile({ ...env, MONGODB_PERFORMANCE_DB: 'old-db' })).toThrow();
    expect(() => performanceProfile({ ...env, COUNTRY_CODE: 'VN' })).toThrow();
    expect(() => performanceProfile({ ...env, INSIGHTS_MOCK_AGENTS: '{}' })).toThrow();
  });
  it('AC-PA-DIRECT-01 removes legacy Mongo selection, retaining isolated offline tests', async () => {
    vi.stubEnv('INSIGHTS_DATA_SOURCE', 'mongo');
    await expect(createSource()).rejects.toThrow('legacy Mongo adapter');
    vi.stubEnv('INSIGHTS_DATA_SOURCE', 'memory');
    expect((await createSource()).kind).toBe('memory');
    vi.stubEnv('INSIGHTS_DATA_SOURCE', 'performance');
    vi.stubEnv('MONGODB_URI', '');
    await expect(createSource()).rejects.toThrow('connection required');
  });
  it('AC-PA-DIRECT-04 maps PTD, preserves zero, emits EMPTY for null, only reads three collections', async () => {
    const { source, queried } = setup();
    const list = await source.metricList(agent, lens, 'PRIORITY');
    expect(list.items.map(x => x.metricCode)).toEqual(['TPC', 'PTPC', 'CASE_COUNT', 'FYP']);
    expect(list.items[0]?.collected).toEqual({ kind: 'MONEY', amount: '4538.76', currency: 'MYR' });
    const selected = await source.metricList(agent, lens, 'PRIORITY', ['TPC', 'FYC']);
    expect(selected.items.map(x => x.metricCode)).toEqual(['TPC', 'FYC']);
    expect(selected.items[1]).toMatchObject({ dataState: 'EMPTY' });
    expect(selected.items[1]).not.toHaveProperty('collected');
    const zero = await source.metricDetail(agent, 'TPC', { ...lens, period: 'MTD' });
    expect(zero?.primary?.collected).toMatchObject({ amount: '0.00' });
    expect(zero?.dataState).toBe('OK');
    expect(new Set(queried)).toEqual(new Set(PERFORMANCE_COLLECTIONS));
  });
  it('AC-PA-DIRECT-04 rounds source money with decimal integer arithmetic', async () => {
    expect(sourceMoney(12668.720000000001)).toBe('12668.72');
    expect(sourceMoney(5815.679999999999)).toBe('5815.68');
    expect(sourceMoney('1.005')).toBe('1.01');
    expect(sourceMoney('-1.005')).toBe('-1.01');
    expect(sourceMoney(1e-7)).toBe('0.00');
    expect(() => sourceMoney(Infinity)).toThrow();
    const detail = await setup().source.metricDetail(agent, 'TPC', lens);
    expect(detail?.altVariants?.[0]?.collected).toMatchObject({ amount: '12668.72' });
  });
  it('AC-PA-DIRECT-05 maps Group MAPA units without fabricated bars or other agents', async () => {
    const { source } = setup();
    const list = await source.metricList(leader, team, 'ALL');
    expect(list.items.find(x => x.metricCode === 'MANPOWER')?.collected).toEqual({ kind: 'COUNT', value: 12 });
    expect(list.items.find(x => x.metricCode === 'PRODUCTIVITY')?.collected).toEqual({ kind: 'DECIMAL', value: 1, precision: 1 });
    expect(list.items.find(x => x.metricCode === 'ACTIVITY_RATIO')?.collected).toEqual({ kind: 'PERCENT', value: 12 });
    expect(list.items.find(x => x.metricCode === 'AVERAGE_CASE_SIZE')?.collected).toMatchObject({ amount: '3922.00' });
    expect(list.items.find(x => x.metricCode === 'NEW_RECRUIT_CONTRACTED')?.collected).toEqual({ kind: 'COUNT', value: 0 });
    expect(await source.metricDetail(leader, 'MANPOWER', team)).not.toHaveProperty('barComparison');
    expect(list.context.period.endDate).toBe('2025-05-28');
  });
  it('AC-PA-DIRECT-06 uses persistency YTD fractions and never bonus/MTD substitutions', async () => {
    const { source } = setup();
    expect((await source.metricDetail(other, 'PERSISTENCY_Y1', team))?.primary?.collected).toEqual({ kind: 'PERCENT', value: 88 });
    expect((await source.metricDetail(other, 'PERSISTENCY_CY', team))?.primary?.collected).toEqual({ kind: 'PERCENT', value: 100 });
    expect((await source.metricDetail(other, 'PERSISTENCY_Y1', { ...team, period: 'MTD' }))?.dataState).toBe('EMPTY');
  });
  it('AC-PA-DIRECT-07 never joins different agents or substitutes unsupported lenses', async () => {
    const { source } = setup();
    expect((await source.metricDetail(leader, 'TPC', team))?.dataState).toBe('EMPTY');
    expect((await source.metricDetail(other, 'PRODUCTIVITY', team))?.dataState).toBe('EMPTY');
    for (const unsupported of [{ ...lens, businessLine: 'ALL' as const }, { ...lens, businessLine: 'TAKAFUL' as const }, { ...lens, basis: 'SCHEME' as const }]) {
      expect((await source.metricList(agent, unsupported, 'ALL')).items.every(x => x.dataState === 'EMPTY')).toBe(true);
    }
    expect((await source.metricList(leader, { ...team, teamView: 'DIRECT' }, 'ALL')).items.every(x => x.dataState === 'EMPTY')).toBe(true);
  });
  it('AC-PA-DIRECT-08 list/detail select the same newest reporting period, not the refresh year', async () => {
    const older = { ...production, period: { ...period, year: 2024 } };
    const source = new PerformanceSource(fakeDb({ my_production: [older, production] }).db, agents);
    const list = await source.metricList(agent, lens, 'ALL');
    expect(list.context).toEqual((await source.metricDetail(agent, 'TPC', lens))?.context);
    expect(list.context.period).toEqual({ type: 'YTD', startDate: '2025-01-01', endDate: '2025-05-31' });
    expect(list.context.asOfDate).toBe('2026-09-07');
  });
  it('AC-PA-DIRECT-09 domain/BFF require allowlisted identity and enforce tenant, own data and tier', async () => {
    const app = buildApp(setup().source); apps.push(app);
    const url = '/insights/v1/agents/MOCK_SELF/metrics?businessLine=INSURANCE';
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { 'x-agent-id': 'MOCK_GROUP' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `${url}&scope=TEAM`, headers: { 'x-agent-id': 'MOCK_SELF' } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: { 'x-agent-id': 'MOCK_SELF', 'x-tenant': 'VN' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/bff/v1/performance/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/bff/v1/performance/dashboard?scope=TEAM', headers: { 'x-agent-id': 'MOCK_SELF' } })).statusCode).toBe(403);
  });
  it('AC-PA-DIRECT-08 AC-PA-DIRECT-11 BFF uses source period years without leaking storage/PII', async () => {
    const app = buildApp(setup().source); apps.push(app);
    const headers = { 'x-agent-id': agent.agentId };
    const res = await app.inject({ url: '/api/bff/v1/performance/dashboard?businessLine=INSURANCE&period=YTD', headers });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.meta.asOfDate).toBe('2026-09-07');
    expect(payload.filters.periodOptionsMeta.find((p: { period: string }) => p.period === 'YTD').startDate).toBe('2025-01-01');
    expect(payload.focusMetrics.items.find((p: { metricCode: string }) => p.metricCode === 'FYC')).not.toHaveProperty('value');
    const detail = (await app.inject({ url: '/api/bff/v1/performance/metrics/TPC?businessLine=INSURANCE', headers })).json();
    expect(detail.sections.find((s: { type: string }) => s.type === 'VARIANT_VALUE').periodLabelYear).toBe(2025);
    for (const forbidden of ['agentName', 'agent_name', 'key_secret', 'vault.azure', PERFORMANCE_DB]) expect(res.body).not.toContain(forbidden);
  });
  it('AC-PA-DIRECT-10 support endpoints are empty, and preferences use memory without extra DB reads', async () => {
    const { source, queried } = setup();
    expect((await source.milestones(agent)).items).toEqual([]);
    expect((await source.recommendations(agent)).items).toEqual([]);
    expect((await source.metricSeries(agent, 'TPC', lens, 2025, 0))?.series[0]?.points.every(p => p.value === null)).toBe(true);
    expect((await source.metricSeries(agent, 'TPC', lens, 2025, 0))?.context).not.toHaveProperty('period');
    expect(await source.recordFeedback()).toBe(false);
    const count = queried.length;
    const prefs = await source.getPreferences(agent, 'SELF', 'STANDARD');
    expect((await source.putPreferences(agent, 'SELF', 'STANDARD', prefs)).ok).toBe(true);
    expect(queried.length).toBe(count);
  });

  it('AC-PA-DIRECT-18 queries exact keys with projection and a bounded timeout', async () => {
    const { db, requests } = fakeDb({ my_production: [production] });
    await new PerformanceSource(db, agents).metricList(agent, lens, 'ALL');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.query).toEqual({ agent_id: agent.agentId, entity: 'PAMB', agent_aggregation: 'Personal', case_status: 'Collected' });
    expect(requests[1]?.query).toEqual({ agentId: agent.agentId, entity: 'PAMB', agentAggregation: 'Personal' });
    for (const request of requests) {
      expect(request.options.maxTimeMS).toBe(8000);
      expect(request.options.projection).toEqual({ _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 });
    }
  });
  it('AC-PA-DIRECT-19 AC-PA-DIRECT-20 typed money survives API mapping and bad siblings stay EMPTY', async () => {
    const row = structuredClone(production);
    row.ptd.tpc.withoutRepricing.ytd = Decimal128.fromString('999999999999999.99');
    row.ptd.fyp.ytd = 'not-a-number';
    row.ptd.caseCount.total.ytd = Decimal128.fromString('4.00000000000000000001');
    const source = new PerformanceSource(fakeDb({ my_production: [row] }).db, agents);
    const list = await source.metricList(agent, lens, 'PRIORITY');
    expect(list.items.find(x => x.metricCode === 'TPC')?.collected).toMatchObject({ amount: '999999999999999.99' });
    expect(list.items.find(x => x.metricCode === 'FYP')?.dataState).toBe('EMPTY');
    expect(list.items.find(x => x.metricCode === 'CASE_COUNT')?.dataState).toBe('EMPTY');
  });
  it('AC-PA-DIRECT-21 no rows produce controlled domain and BFF 404, not a synthetic date or 500', async () => {
    const app = buildApp(new PerformanceSource(fakeDb().db, agents)); apps.push(app);
    for (const url of ['/insights/v1/agents/MOCK_SELF/metrics?businessLine=INSURANCE', '/insights/v1/agents/MOCK_SELF/metrics/TPC?businessLine=INSURANCE', '/api/bff/v1/performance/dashboard?businessLine=INSURANCE']) {
      const result = await app.inject({ url, headers: { 'x-agent-id': agent.agentId } });
      expect(result.statusCode).toBe(404);
      expect(result.json().code).toBe('INS-4040');
      expect(result.body).not.toContain('2026-');
      expect(result.body).not.toContain(agent.agentId);
    }
  });
  it('AC-PA-DIRECT-22 bad selected metadata and driver failures are safe service errors, not EMPTY', async () => {
    const bad = { ...production, asOnDate: '2025-02-30T00:00:00Z' };
    const invalidApp = buildApp(new PerformanceSource(fakeDb({ my_production: [bad] }).db, agents)); apps.push(invalidApp);
    const invalid = await invalidApp.inject({ url: '/insights/v1/agents/MOCK_SELF/metrics', headers: { 'x-agent-id': agent.agentId } });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).toContain('Performance source metadata is invalid');
    expect(invalid.body).not.toContain('2025-02-30');
    const db = { databaseName: PERFORMANCE_DB, collection: () => ({ find: () => { throw new Error('mongodb://secret-user:secret-password@private-host'); } }) } as unknown as Db;
    const app = buildApp(new PerformanceSource(db, agents)); apps.push(app);
    for (const url of ['/insights/v1/agents/MOCK_SELF/metrics', '/api/bff/v1/performance/dashboard']) {
      const result = await app.inject({ url, headers: { 'x-agent-id': agent.agentId } });
      expect(result.statusCode).toBeGreaterThanOrEqual(500);
      expect(result.body).not.toMatch(/secret-user|secret-password|private-host|mongodb:/);
      expect(result.body).toContain('Performance source read failed');
    }
  });
  it('AC-PA-DIRECT-24 reads updated documents again without a file import or restart', async () => {
    const row = structuredClone(production);
    const data = { my_production: [row] };
    const source = new PerformanceSource(fakeDb(data).db, agents);
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    row.ptd.tpc.withoutRepricing.ytd = 6543.21;
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '6543.21' });
  });
});

function schemaFixture(schema: ReturnType<typeof sourceSchema>): unknown {
  const types = [schema.bsonType].flat();
  if (types.includes('object')) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, schemaFixture(child)]));
  if (types.includes('null')) return 'null';
  if (types.includes('objectId')) return { $oid: '0123456789abcdef01234567' };
  if (types.includes('date')) return { $date: '2026-09-07T00:00:00.000Z' };
  if (types.includes('string')) return 'mock';
  return 1;
}
function raw(collection: PerformanceCollection): Document {
  const row = schemaFixture(sourceSchema(collection)) as Document;
  row.period = { ...row.period, ...period };
  row.asOnDate = collection === 'my_production' ? '2026-09-07T11:09:09Z' : { $date: '2026-09-07T00:00:00.000Z' };
  row.id = 'mock-source-row';
  row[collection === 'my_production' ? 'agent_name' : 'agentName'] = '{"cipher_text":"secret","key_secret":"https://vault.invalid"}';
  delete row[collection === 'my_production' ? 'scheme_type' : 'schemeType'];
  if (collection === 'my_mapa') row.period.asOnMonthDay = 28;
  row.undeclared = 'do not store';
  return row;
}
describe('three-collection import safety', () => {
  it('AC-PA-DIRECT-03 schema comparison accepts only equivalent ordering/defaults, not changed types or constraints', () => {
    const schema = { $jsonSchema: { bsonType: 'object', required: ['a', 'b'], properties: { a: { bsonType: ['double', 'null'] } } } };
    const equivalent = { $jsonSchema: { additionalProperties: true, required: ['b', 'a'], bsonType: 'object', properties: { a: { bsonType: ['null', 'double'] } } } };
    expect(equivalentValidator(schema, equivalent)).toBe(true);
    expect(equivalentValidator(schema, { $jsonSchema: { ...schema.$jsonSchema, additionalProperties: false } })).toBe(false);
    expect(equivalentValidator(schema, { $jsonSchema: { ...schema.$jsonSchema, required: ['a'] } })).toBe(false);
    expect(equivalentValidator(schema, { $jsonSchema: { ...schema.$jsonSchema, properties: { a: { bsonType: 'int' } } } })).toBe(false);
  });
  it('AC-PA-DIRECT-02 parses JSON and only the documented final-array comma repair', () => {
    expect(parseMockRecords('[{"x":1},\n]')).toEqual([{ x: 1 }]);
    expect(parseMockRecords('{"x":1}')).toEqual([{ x: 1 }]);
    expect(() => parseMockRecords('[process.exit()]')).toThrow('Invalid mock JSON');
    expect(() => parseMockRecords('[{"x":1,}]')).toThrow();
  });
  it('AC-PA-DIRECT-02 normalizes BSON/null/day types and projects/redacts sensitive fields', () => {
    for (const collection of PERFORMANCE_COLLECTIONS) {
      const row = normalizeMockRecord(collection, raw(collection));
      expect(row._id._bsontype).toBe('ObjectId');
      expect(row.period.year._bsontype).toBe('Int32');
      expect(row[collection === 'my_production' ? 'scheme_type' : 'schemeType']).toBeNull();
      expect(row).not.toHaveProperty('undeclared');
      expect(BSON.EJSON.stringify(row)).not.toMatch(/cipher_text|key_secret|vault\.invalid/);
      if (collection === 'my_mapa') {
        expect(row.period.asOnMonthDay).toBe('28');
        expect(row.ptd.productivity.ytd._bsontype).toBe('Int32');
      }
      if (collection === 'my_persistency') expect(row.metrics.ytd.current_year_persistency._bsontype).toBe('Double');
    }
  });
  it('AC-PA-DIRECT-02 rejects missing fields, invalid integers/dates and inconsistent periods', () => {
    const record = raw('my_mapa'); record.ptd.productivity.ytd = 1.5;
    expect(() => normalizeMockRecord('my_mapa', record)).toThrow('Invalid BSON type');
    const invalid = raw('my_production'); invalid.period.quarter = 'Q4';
    expect(() => normalizeMockRecord('my_production', invalid)).toThrow('Inconsistent reporting period');
    delete invalid.period;
    expect(() => normalizeMockRecord('my_production', invalid)).toThrow('Missing field');
  });
  it('AC-PA-DIRECT-03 identical imports skip records; conflicts and duplicate input keys fail', async () => {
    const row = normalizeMockRecord('my_production', raw('my_production'));
    const rows: MockImport = { my_production: [row], my_mapa: [], my_persistency: [] };
    expect((await inspectImport(fakeDb().db, rows)).counts.my_production).toEqual({ input: 1, insert: 1, unchanged: 0 });
    expect((await inspectImport(fakeDb({ my_production: [row] }).db, rows)).counts.my_production).toEqual({ input: 1, insert: 0, unchanged: 1 });
    expect(documentFingerprint(row)).toBe(documentFingerprint(BSON.deserialize(BSON.serialize(row), { promoteValues: false })));
    await expect(inspectImport(fakeDb({ my_production: [{ ...row, entity: 'changed' }] }).db, rows)).rejects.toThrow('Conflicting');
    await expect(inspectImport(fakeDb().db, { ...rows, my_production: [row, row] })).rejects.toThrow('Duplicate');
    await expect(inspectImport(fakeDb({}, 'wrong-db').db, rows)).rejects.toThrow('target');
  });
});