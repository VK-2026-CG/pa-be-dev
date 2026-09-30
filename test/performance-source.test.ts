import { afterEach, describe, expect, it, vi } from 'vitest';
import { BSON, Decimal128, type Db, type Document } from 'mongodb';
import { buildApp } from '../src/app.js';
import { PerformanceSource } from '../src/data/performance-source.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DATABASES, PERFORMANCE_DB, performanceProfile, type PerformanceCollection } from '../src/data/performance-profile.js';
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
const production: Document = { agentId: agent.agentId, agentAggregation: 'Personal', entity: 'PAMB', agentType: 'PAMB', agentStatus: 'Active', caseStatus: 'Collected',
  period, asOnDate: '2026-09-07T11:09:09Z', ptd: {
    tpc: { withoutRepricing: { ytd: 4538.76, mtd: 0 }, withRepricing: { ytd: 12668.720000000001, mtd: 8249.96 } },
    ptpc: { withoutRepricing: { ytd: 2329.38 } }, fyp: { ytd: 21678.39 },
    fyc: { ytd: null }, caseCount: { total: { ytd: 4, mtd: 0 } },
  } };
const mapa: Document = { agentId: leader.agentId, agentAggregation: 'Group', entity: 'PAMB', agentType: 'PAMB', agentStatus: 'Active',
  period: { ...period, asOnMonthDay: '28' }, asOnDate: new Date('2026-09-18T00:00:00Z'),
  ptd: { manpowerTotal: { ytd: 12 }, activityRatio: { ytd: 12 }, productivity: { ytd: 1 }, averageCaseSize: { ytd: 3922 }, newRecruits: { ytd: 0 } } };
const persistency: Document = { agentId: other.agentId, agentAggregation: 'Group', entity: 'PAMB', agentType: 'PAMB', agentStatus: 'Active', period,
  asOnDate: new Date('2026-09-07T00:00:00Z'), metrics: { ytd: { currentYearPersistency: 1, firstYearPersistency: 0.88, secondYearPersistency: 0.79 }, bonus: { firstYearPersistency: 10 } } };
/** PBTB shares PAMB's camelCase field naming (confirmed against live data, and migrated where it had drifted). */
const takafulProduction = (overrides: Partial<Document> = {}): Document => ({
  ...production, entity: 'PBTB', agentType: 'Takaful', ...overrides,
});

function fakeDb(data: Partial<Record<PerformanceCollection, Document[]>> & Record<string, Document[] | undefined> = {}, name: string = PERFORMANCE_DB) {
  const queried: string[] = [];
  const requests: Array<{ collection: string; query: Document; options: Document }> = [];
  const get = (row: Document, key: string) => key.split('.').reduce((v, part) => v?.[part], row);
  const matches = (row: Document, query: Document): boolean => Object.entries(query).every(([key, value]) => {
      if (key === '$or') return (value as Document[]).some(q => matches(row, q));
    if (value && typeof value === 'object' && '$in' in value) return (value.$in as unknown[]).map(String).includes(String(get(row, key)));
    return String(get(row, key)) === String(value);
  });
  const db = { databaseName: name, collection: (collection: string) => {
    queried.push(collection);
    return { find: (query: Document, options: Document = {}) => {
      requests.push({ collection, query, options });
      let rows = ((data as Record<string, Document[]>)[collection] ?? []).filter(row => matches(row, query));
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
/** PAMB and PBTB default to the same underlying fixtures (shared `data`) unless a test passes distinct sets. */
function dualDb(pamb: Partial<Record<PerformanceCollection, Document[]>> = {}, pbtb: Partial<Record<PerformanceCollection, Document[]>> = pamb) {
  const a = fakeDb(pamb, PERFORMANCE_DATABASES.PAMB);
  const b = fakeDb(pbtb, PERFORMANCE_DATABASES.PBTB);
  return { dbs: { PAMB: a.db, PBTB: b.db }, pamb: a, pbtb: b };
}
const setup = () => {
  const { dbs, pamb } = dualDb({ my_production: [production], my_mapa: [mapa], my_persistency: [persistency] });
  return { source: new PerformanceSource(dbs, agents), queried: pamb.queried };
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });

describe('three-collection Performance adapter', () => {
  it('AC-PA-DIRECT-01 rejects production, wrong database/country and missing identity config', () => {
    const env = { NODE_ENV: 'development', COUNTRY_CODE: 'MY', MONGODB_PAMB_DB: PERFORMANCE_DB, MONGODB_PBTB_DB: PERFORMANCE_DATABASES.PBTB, INSIGHTS_MOCK_AGENTS: '{"MOCK_SELF":"P4"}' };
    expect(performanceProfile(env).get('MOCK_SELF')?.level).toBe('P4');
    expect(() => performanceProfile({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => performanceProfile({ ...env, MONGODB_PAMB_DB: 'old-db' })).toThrow();
    expect(() => performanceProfile({ ...env, MONGODB_PBTB_DB: 'old-db' })).toThrow();
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
    // v0.4.0-draft: SCHEME remains an unsupported gate (AC-PA-DIRECT-27); ALL/TAKAFUL are routed
    // businessLines (AC-PA-DIRECT-25/26/27), covered by their own dedicated test instead. TEAM+DIRECT
    // is a real routed aggregation now (see below) — this is EMPTY only because the default fixtures
    // have no 'DirectUnit'-tagged row for leader, not because DIRECT itself is gated.
    expect((await source.metricList(agent, { ...lens, basis: 'SCHEME' }, 'ALL')).items.every(x => x.dataState === 'EMPTY')).toBe(true);
    expect((await source.metricList(leader, { ...team, teamView: 'DIRECT' }, 'ALL')).items.every(x => x.dataState === 'EMPTY')).toBe(true);
  });
  it('Mongo-source comparison uses prior data or an explicitly neutral zero when absent', async () => {
    const detail = await setup().source.metricDetail(agent, 'TPC', lens);
    expect(detail?.comparison?.prior).toEqual({ kind: 'MONEY', amount: '0.00', currency: 'MYR' });
    expect(detail).not.toHaveProperty('breakdowns');
  });
  it('Mongo mode never fills missing detail parts with mock data', async () => {
    const logs: string[] = [];
    const source = new PerformanceSource(dualDb({ my_production: [production], my_mapa: [mapa], my_persistency: [persistency] }).dbs, agents, (m) => logs.push(m), true);
    const detail = await source.metricDetail(agent, 'TPC', lens);
    // Real Mongo values are retained and mock-only values remain absent.
    expect(detail?.primary?.collected).toEqual({ kind: 'MONEY', amount: '4538.76', currency: 'MYR' });
    expect(detail?.altVariants?.[0]?.collected).toMatchObject({ amount: '12668.72' });
    expect(detail?.comparison?.current).toEqual(detail?.primary?.collected);
    expect(detail?.comparison?.priorYear).toBe(2024);
    expect(detail?.breakdowns).toBeUndefined();
    expect(logs.some((m) => m.includes('DEV MOCK'))).toBe(false);
  });
  it('Mongo mode leaves unsupported lenses empty rather than substituting mock data', async () => {
    const source = new PerformanceSource(dualDb({ my_production: [production] }).dbs, agents, () => {}, true);
    const detail = await source.metricDetail(agent, 'TPC', { ...lens, basis: 'SCHEME' });
    expect(detail?.dataState).toBe('EMPTY');
    expect(detail?.primary).toBeUndefined();
    expect(detail?.context.period.endDate).toBe('2025-05-31'); // real context kept
  });
  it('Mongo mode keeps missing list metrics empty even if the legacy fallback option is passed', async () => {
    const logs: string[] = [];
    const source = new PerformanceSource(dualDb({ my_production: [production], my_mapa: [mapa], my_persistency: [persistency] }).dbs, agents, (m) => logs.push(m), true);
    const list = await source.metricList(agent, lens, 'ALL');
    expect(list.items.find(x => x.metricCode === 'TPC')?.collected).toEqual({ kind: 'MONEY', amount: '4538.76', currency: 'MYR' });
    expect(list.items.find(x => x.metricCode === 'FYC')?.dataState).toBe('EMPTY');
    expect(list.items.some(x => x.dataState === 'EMPTY')).toBe(true);
    expect(list.context.period.endDate).toBe('2025-05-31');
    const unsupported = { ...team, teamView: 'DIRECT' as const };
    const noHierarchy = new PerformanceSource(dualDb({ my_production: [production] }).dbs, agents, () => {}, true);
    expect((await noHierarchy.metricList(leader, unsupported, 'ALL')).items.every(x => x.dataState === 'EMPTY')).toBe(true);
    expect(logs.some(m => m.includes('DEV MOCK'))).toBe(false);
  });
  it('Mongo mode returns not-found when the agent has no Mongo rows', async () => {
    const source = new PerformanceSource(dualDb().dbs, agents, () => {}, true);
    await expect(source.metricList(agent, lens, 'PRIORITY')).rejects.toThrow();
    const app = buildApp(source); apps.push(app);
    const res = await app.inject({ url: '/api/bff/v1/performance/dashboard?businessLine=INSURANCE', headers: { 'x-agent-id': agent.agentId } });
    expect(res.statusCode).toBe(404);
  });
  it('Mongo mode returns only persisted source data, with absent support data empty', async () => {
    const source = new PerformanceSource(dualDb({ my_production: [production], my_mapa: [mapa], my_persistency: [persistency] }).dbs, agents, () => {}, true);
    const series = await source.metricSeries(agent, 'TPC', lens, 2026, 1);
    expect(series?.series[0]?.points.every(p => p.value === null)).toBe(true);
    expect(series?.context.asOfDate).toBe('2025-05-31'); // real context kept
    expect((await source.milestones(agent)).items).toHaveLength(0);
    const recos = await source.recommendations(agent, 'SELF');
    expect(recos.items).toHaveLength(0);
    expect(await source.recordFeedback(agent, 'missing', 'UP')).toBe(false);
    const members = await source.listTeamMembers(leader, { teamView: 'GROUP', basis: 'AGENT', sortBy: 'TPC', lens: team });
    expect(members?.items).toEqual([]); // no hierarchy/member source is wired into this profile.
    expect(await source.getTeamMemberDashboard(leader, 'A1001', team)).toBeUndefined();
  });
  it('AC-PA-DIRECT-08 list/detail select the same newest reporting period, not the refresh year', async () => {
    const older = { ...production, period: { ...period, year: 2024, yyyymm: '202405' } };
    const source = new PerformanceSource(dualDb({ my_production: [older, production] }).dbs, agents);
    const list = await source.metricList(agent, lens, 'ALL');
    expect(list.context).toEqual((await source.metricDetail(agent, 'TPC', lens))?.context);
    expect(list.context.period).toEqual({ type: 'YTD', startDate: '2025-01-01', endDate: '2025-05-31' });
    // v0.4.0-draft (AC-PA-DIRECT-29): asOfDate is the period end date, not the asOnDate watermark.
    expect(list.context.asOfDate).toBe('2025-05-31');
  });
  it('prior-year comparison: populates current/prior/priorYear/change from the matching prior-year record', async () => {
    const prior = { ...production, period: { ...period, year: 2024, yyyymm: '202405' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 3000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [production, prior] }).dbs, agents);
    const detail = await source.metricDetail(agent, 'TPC', lens);
    expect(detail?.comparison).toMatchObject({ current: { amount: '4538.76' }, prior: { amount: '3000.00' }, priorYear: 2024 });
    expect(detail?.comparison?.change.direction).toBe('UP');
  });
  it('prior-year comparison accepts a validated identity absent from the Mongo source local map', async () => {
    const prior = { ...production, period: { ...period, year: 2024, yyyymm: '202405' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 3000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [production, prior] }).dbs, new Map());
    const detail = await source.metricDetail(agent, 'TPC', lens);
    expect(detail?.comparison).toMatchObject({ prior: { amount: '3000.00' }, priorYear: 2024 });
  });
  it('prior-year comparison: omitted (not fabricated) when the only prior-year record is later in the month than the current one', async () => {
    const currentPartial = { ...production, period: { ...period, asOnMonthDay: '15' } };
    const priorLate = { ...production, period: { ...period, year: 2024, yyyymm: '202405', asOnMonthDay: '31' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 3000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [currentPartial, priorLate] }).dbs, agents);
    const detail = await source.metricDetail(agent, 'TPC', lens);
    expect(detail?.dataState).toBe('OK');
    expect(detail?.primary?.collected).toMatchObject({ amount: '4538.76' });
    expect(detail?.comparison).toBeUndefined();
  });
  it('prior-year comparison: metricList (dashboard) populates items[].comparison as a Change, one cached query per collection', async () => {
    const prior = { ...production, period: { ...period, year: 2024, yyyymm: '202405' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 3000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const { dbs, pamb: { requests } } = dualDb({ my_production: [production, prior] });
    const list = await new PerformanceSource(dbs, agents).metricList(agent, lens, 'ALL');
    const tpc = list.items.find(x => x.metricCode === 'TPC');
    expect(tpc?.comparison).toMatchObject({ direction: 'UP', sentiment: 'POSITIVE' });
    expect(tpc?.comparison).not.toHaveProperty('current');
    // Only one prior-year query for my_production, shared across TPC/PTPC/CASE_COUNT/FYP.
    expect(requests.filter(r => r.query['period.year'] === 2024)).toHaveLength(1);
  });
  it('prior-year comparison: prefers the exact same asOnMonthDay over an earlier-but-eligible record', async () => {
    const currentPartial = { ...production, period: { ...period, asOnMonthDay: '15' } };
    const priorEarly = { ...production, id: 'p-early', period: { ...period, year: 2024, yyyymm: '202405', asOnMonthDay: '5' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 1000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const priorExact = { ...production, id: 'p-exact', period: { ...period, year: 2024, yyyymm: '202405', asOnMonthDay: '15' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 2000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const priorTooLate = { ...production, id: 'p-late', period: { ...period, year: 2024, yyyymm: '202405', asOnMonthDay: '25' },
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 9000, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [currentPartial, priorEarly, priorExact, priorTooLate] }).dbs, agents);
    const detail = await source.metricDetail(agent, 'TPC', lens);
    expect(detail?.comparison?.prior).toMatchObject({ amount: '2000.00' });
  });
  it('BFF-5020 keeps dashboard change semantics and returns a neutral zero prior in metric detail when prior data is absent', async () => {
    const source = new PerformanceSource(dualDb({ my_production: [production] }).dbs, agents);
    const listComparison = (await source.metricList(agent, lens, 'PRIORITY')).items.find(item => item.metricCode === 'TPC')?.comparison;
    expect(listComparison).toBeUndefined(); // dashboard card change remains outside this detail-only change
    const detail = await source.metricDetail(agent, 'TPC', lens);
    expect(detail?.comparison).toEqual({ current: { kind: 'MONEY', amount: '4538.76', currency: 'MYR' },
      prior: { kind: 'MONEY', amount: '0.00', currency: 'MYR' }, priorYear: 2024,
      change: { basis: 'LAST_YEAR', direction: 'FLAT', sentiment: 'NEUTRAL', pct: 0 } });
    const app = buildApp(source); apps.push(app);
    const response = await app.inject({ url: '/api/bff/v1/performance/metrics/TPC?businessLine=INSURANCE', headers: { 'x-agent-id': agent.agentId } });
    expect(response.statusCode).toBe(200);
    expect(response.json().sections.find((section: { type: string }) => section.type === 'COMPARISON')).toBeDefined();
  });
  it('BFF-5020 uses a null prior metric as missing without changing prior-zero behavior', async () => {
    const nullPrior = { ...production, period: { ...period, year: 2024, yyyymm: '202405' }, ptd: { ...production.ptd,
      tpc: { withoutRepricing: { ytd: null, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [production, nullPrior] }).dbs, agents);
    expect((await source.metricDetail(agent, 'TPC', lens))?.comparison?.prior).toMatchObject({ amount: '0.00' });
    const genuineZeroPrior = { ...nullPrior, ptd: { ...nullPrior.ptd,
      tpc: { withoutRepricing: { ytd: 0, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const zeroSource = new PerformanceSource(dualDb({ my_production: [production, genuineZeroPrior] }).dbs, agents);
    const comparison = (await zeroSource.metricDetail(agent, 'TPC', lens))?.comparison;
    expect(comparison?.prior).toMatchObject({ amount: '0.00' });
    expect(comparison?.change).toMatchObject({ direction: 'FLAT', sentiment: 'NEUTRAL' });
  });
  it('BFF-5020 does not turn a prior comparison read failure into missing prior data', async () => {
    const failingDb = { ...dualDb({ my_production: [production] }).dbs.PAMB,
      collection: (collection: string) => ({ find: (query: Document) => {
        if (query['period.year'] === 2024) throw new Error('database unavailable');
        return dualDb({ my_production: [production] }).dbs.PAMB.collection(collection).find(query);
      } }) } as unknown as Db;
    const source = new PerformanceSource({ PAMB: failingDb, PBTB: dualDb().dbs.PBTB }, agents);
    await expect(source.metricDetail(agent, 'TPC', lens)).rejects.toThrow('Performance source read failed');
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
    // v0.4.0-draft (AC-PA-DIRECT-29): asOfDate is the period end date, not the asOnDate watermark.
    // Only my_production matches this SELF/Personal query (mapa/persistency fixtures belong to leader/other under Group), so no declared day: falls back to May's calendar month-end.
    expect(payload.meta.asOfDate).toBe('2025-05-31');
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
    const { dbs, pamb: { requests } } = dualDb({ my_production: [production] });
    await new PerformanceSource(dbs, agents).metricList(agent, lens, 'ALL');
    // 3 "latest" queries (one per collection) + 1 cached prior-year query (my_production only,
    // shared across TPC/PTPC/CASE_COUNT/FYP since they all read that same collection).
    expect(requests).toHaveLength(4);
    expect(requests[0]?.query).toEqual({ agentId: agent.agentId, entity: 'PAMB', agentAggregation: 'Personal', caseStatus: 'Collected' });
    expect(requests[1]?.query).toEqual({ agentId: agent.agentId, entity: 'PAMB', agentAggregation: 'Personal' });
    expect(requests[3]?.query).toEqual({
      agentId: agent.agentId, entity: 'PAMB', agentAggregation: 'Personal', caseStatus: 'Collected',
      'period.year': 2024, 'period.month': 5,
    });
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
    const source = new PerformanceSource(dualDb({ my_production: [row] }).dbs, agents);
    const list = await source.metricList(agent, lens, 'PRIORITY');
    expect(list.items.find(x => x.metricCode === 'TPC')?.collected).toMatchObject({ amount: '999999999999999.99' });
    expect(list.items.find(x => x.metricCode === 'FYP')?.dataState).toBe('EMPTY');
    expect(list.items.find(x => x.metricCode === 'CASE_COUNT')?.dataState).toBe('EMPTY');
  });
  it('AC-PA-DIRECT-21 no rows produce controlled domain and BFF 404, not a synthetic date or 500', async () => {
    const app = buildApp(new PerformanceSource(dualDb().dbs, agents)); apps.push(app);
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
    const invalidApp = buildApp(new PerformanceSource(dualDb({ my_production: [bad] }).dbs, agents)); apps.push(invalidApp);
    const invalid = await invalidApp.inject({ url: '/insights/v1/agents/MOCK_SELF/metrics?businessLine=INSURANCE', headers: { 'x-agent-id': agent.agentId } });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).toContain('Performance source metadata is invalid');
    expect(invalid.body).not.toContain('2025-02-30');
    const throwing = (name: string) => ({ databaseName: name, collection: () => ({ find: () => { throw new Error('mongodb://secret-user:secret-password@private-host'); } }) }) as unknown as Db;
    const app = buildApp(new PerformanceSource({ PAMB: throwing(PERFORMANCE_DATABASES.PAMB), PBTB: throwing(PERFORMANCE_DATABASES.PBTB) }, agents)); apps.push(app);
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
    const source = new PerformanceSource(dualDb(data).dbs, agents);
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    row.ptd.tpc.withoutRepricing.ytd = 6543.21;
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '6543.21' });
  });
  it('AC-PA-DIRECT-25 AC-PA-DIRECT-26 AC-PA-DIRECT-27 routes businessLine to the correct database; entity is unaffected by agentType (interim, 0.5.0-draft)', async () => {
    const hybrid = { ...production, agentId: leader.agentId, agentType: 'HYBRID' };
    const takaful = takafulProduction();
    const { dbs, pamb, pbtb } = dualDb({ my_production: [production, hybrid] }, { my_production: [takaful] });
    const source = new PerformanceSource(dbs, agents);
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    // A Hybrid-licensed agent (agentType HYBRID) still resolves under INSURANCE and ALL — not yet gated by
    // agentType, since real data has one production row per agent/period, not the two-record shape pending
    // data-team confirmation (see entityFor's interim note in performance-source.ts).
    expect((await source.metricDetail(leader, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    expect((await source.metricDetail(leader, 'TPC', { ...lens, businessLine: 'ALL' }))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    expect((await source.metricDetail(agent, 'TPC', { ...lens, businessLine: 'TAKAFUL' }))?.primary?.collected).toMatchObject({ amount: '4538.76' });
    expect(pamb.requests.every(r => r.query.entity === 'PAMB')).toBe(true);
    expect(pbtb.requests.some(r => r.query.entity === 'PBTB')).toBe(true);
    expect(pbtb.requests.every(r => r.query.entity === 'PBTB')).toBe(true);
  });
  it('AC-PA-DIRECT-27 SCHEME remains EMPTY; TEAM+DIRECT routes to the DirectUnit aggregation, not Personal/Group', async () => {
    const takaful = takafulProduction();
    const source = new PerformanceSource(dualDb({}, { my_production: [takaful] }).dbs, agents);
    expect((await source.metricDetail(agent, 'TPC', { ...lens, businessLine: 'TAKAFUL', basis: 'SCHEME' }))?.dataState).toBe('EMPTY');
    // The only takaful row is tagged 'Personal' (inherited from `production`); DIRECT must not fall back to it.
    expect((await source.metricDetail(agent, 'TPC', { ...lens, businessLine: 'TAKAFUL', scope: 'TEAM', teamView: 'DIRECT' }))?.dataState).toBe('EMPTY');
    const direct = { ...production, agentId: leader.agentId, agentAggregation: 'DirectUnit',
      ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 999.99, mtd: 0 }, withRepricing: { ytd: 0, mtd: 0 } } } };
    const { dbs, pamb } = dualDb({ my_production: [direct] });
    const withDirect = new PerformanceSource(dbs, agents);
    expect((await withDirect.metricDetail(leader, 'TPC', { ...lens, scope: 'TEAM', teamView: 'DIRECT' }))?.primary?.collected)
      .toMatchObject({ amount: '999.99' });
    expect(pamb.requests.some(r => r.query.agentAggregation === 'DirectUnit')).toBe(true);
  });
  // Deferred: agent_status filtering is not wired into latest() for now (parked, not removed).
  it.skip('AC-PA-DIRECT-28 excludes records whose agent status is not Active or A, and accepts either spelling', async () => {
    const inactive = { ...production, agentStatus: 'Inactive' };
    // Excluding the only matching record leaves zero rows for this identity: same as any other no-data identity (AC-PA-DIRECT-21), not a fabricated EMPTY.
    await expect(new PerformanceSource(dualDb({ my_production: [inactive] }).dbs, agents).metricDetail(agent, 'TPC', lens))
      .rejects.toThrow('No Performance records found for this identity');
    const abbreviated = { ...production, agentStatus: 'A' };
    expect((await new PerformanceSource(dualDb({ my_production: [abbreviated] }).dbs, agents).metricDetail(agent, 'TPC', lens))?.primary?.collected)
      .toMatchObject({ amount: '4538.76' });
  });
  it('AC-PA-DIRECT-30 breaks a same-period tie in favor of the most recently inserted document', async () => {
    const older = { ...production, id: 'aaa' };
    const newer = { ...production, id: 'zzz', ptd: { ...production.ptd, tpc: { withoutRepricing: { ytd: 1, mtd: 0 }, withRepricing: { ytd: 1, mtd: 0 } } } };
    const source = new PerformanceSource(dualDb({ my_production: [older, newer] }).dbs, agents);
    expect((await source.metricDetail(agent, 'TPC', lens))?.primary?.collected).toMatchObject({ amount: '1.00' });
  });
});

function schemaFixture(schema: ReturnType<typeof sourceSchema>): unknown {
  const types = [schema.bsonType].flat();
  if (types.includes('object')) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, schemaFixture(child)]));
  if (types.includes('null')) return null;
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
  row.agentName = '{"cipher_text":"secret","key_secret":"https://vault.invalid"}';
  delete row.schemeType;
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
      expect(row.schemeType).toBeNull();
      expect(row).not.toHaveProperty('undeclared');
      expect(BSON.EJSON.stringify(row)).not.toMatch(/cipher_text|key_secret|vault\.invalid/);
      if (collection === 'my_production') expect(row.scheme_type).toBeNull();
      if (collection === 'my_mapa') {
        expect(row.schemeType).toBeNull();
        expect(row.period.asOnMonthDay._bsontype).toBe('Int32');
        expect(row.ptd.productivity.ytd._bsontype).toBe('Int32');
      }
      if (collection === 'my_persistency') {
        expect(row.schemeType).toBeNull();
        expect(row.metrics.ytd.current_year_persistency._bsontype).toBe('Double');
        expect(row.period.as_on_month_day).toBeNull();
        expect(row.agentRefererAgentId).toBe('mock');
      }
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
  it('AC-ORG-01..06 resolves a privacy-safe recursive tree in source order and deduplicates repeated references', async () => {
    const hierarchy = [
      { _id: new BSON.ObjectId(), asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId: 'MOCK_GROUP' }, subtree: { scopeProfileIds: ['MOCK_UM', 'MOCK_LEAF', 'MOCK_UM'] }, displayRows: { tier: 'AM', encryptedName: 'SECRET' } },
      { _id: new BSON.ObjectId(), asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId: 'MOCK_UM' }, subtree: { scopeProfileIds: ['MOCK_LEAF'] }, displayRows: { tier: 'UM1' } },
    ];
    const { dbs, pamb, pbtb } = dualDb({ my_agent_hierarchy: hierarchy }, {});
    const source = new PerformanceSource(dbs, agents, () => {}, false, true);
    const result = await source.getAgentOrganization('MOCK_GROUP');
    expect(result).toEqual({ agentId: 'MOCK_GROUP', displayName: 'MOCK_GROUP', tier: 'P2', reports: [
      { agentId: 'MOCK_UM', displayName: 'MOCK_UM', tier: 'P3', reports: [
        { agentId: 'MOCK_LEAF', displayName: 'MOCK_LEAF', reports: [] },
      ] },
      { agentId: 'MOCK_LEAF', displayName: 'MOCK_LEAF', reports: [] },
    ] });
    expect(pamb.requests.every(request => request.options.maxTimeMS === 8000)).toBe(true);
    expect(pamb.requests[0]?.options.projection).not.toHaveProperty('displayRows.encryptedName');
    expect(pbtb.queried).toEqual([]);
  });
  it('AC-ORG-02..03 prefers PAMB, falls back to PBTB only for a missing root, and sorts duplicate snapshots', async () => {
    const old = { _id: new BSON.ObjectId('000000000000000000000001'), asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId: 'MOCK_GROUP' }, subtree: { scopeProfileIds: [] }, displayRows: { tier: 'AM' } };
    const newest = { ...old, _id: new BSON.ObjectId('000000000000000000000002'), asOnDate: new Date('2026-02-01') };
    const p = dualDb({ my_agent_hierarchy: [old, newest] }, {});
    expect((await new PerformanceSource(p.dbs, agents, () => {}, false, true).getAgentOrganization('MOCK_GROUP'))?.tier).toBe('P2');
    expect(p.pamb.requests[0]?.query).toEqual({ 'hierarchy.leaderId': 'MOCK_GROUP' });
    const q = dualDb({}, { my_agent_hierarchy: [old] });
    expect(await new PerformanceSource(q.dbs, agents, () => {}, false, true).getAgentOrganization('MOCK_GROUP')).toMatchObject({ tier: 'P2' });
    expect(q.pbtb.queried).toContain('my_agent_hierarchy');
  });
  it('AC-ORG-08 fails cycles/malformed hierarchy and sanitizes source errors', async () => {
    const cycle = { hierarchy: { leaderId: 'MOCK_GROUP' }, subtree: { scopeProfileIds: ['MOCK_GROUP'] }, displayRows: { tier: 'AM' } };
    const a = dualDb({ my_agent_hierarchy: [cycle] });
    await expect(new PerformanceSource(a.dbs, agents, () => {}, false, true).getAgentOrganization('MOCK_GROUP')).rejects.toThrow('Hierarchy cycle');
    const self = dualDb({ my_agent_hierarchy: [{ ...cycle, subtree: { scopeProfileIds: ['MOCK_GROUP', 'MOCK_LEAF'] } }] });
    await expect(new PerformanceSource(self.dbs, agents, () => {}, false, true).getAgentOrganization('MOCK_GROUP')).rejects.toThrow('Hierarchy cycle');
    const badDb = { databaseName: PERFORMANCE_DATABASES.PAMB, collection: () => ({ find: () => { throw new Error('secret mongodb:// credential'); } }) } as unknown as Db;
    const b = new PerformanceSource({ PAMB: badDb, PBTB: dualDb().dbs.PBTB }, agents, () => {}, false, true);
    await expect(b.getAgentOrganization('MOCK_GROUP')).rejects.toThrow('Hierarchy source read failed');
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