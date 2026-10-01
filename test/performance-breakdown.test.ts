import { afterEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { buildApp } from '../src/app.js';
import { PerformanceSource } from '../src/data/performance-source.js';
import { creditPointAmount, metricBreakdowns, productBreakdown } from '../src/data/performance-breakdown.js';
import { PERFORMANCE_BREAKDOWN_MAPPING, PERFORMANCE_PRODUCT_LEAVES, performanceProductPath } from '../src/data/performance-mapping.js';
import { sourceSchema } from '../src/data/performance-import.js';
import type { AgentRecord } from '../src/data/registry.js';
import type { Lens } from '../src/data/values.js';
import { fakeMongo } from './support/mongo-fake.js';

process.env.MONGODB_URI = '';
const agent: AgentRecord = { agentId: 'MOCK_SELF', tenant: 'MY', level: 'P4', name: 'Mock' };
const leader: AgentRecord = { agentId: 'MOCK_GROUP', tenant: 'MY', level: 'P2', name: 'Mock' };
const agents = new Map([agent, leader].map((a) => [a.agentId, a]));
const lens: Lens = { period: 'YTD', businessLine: 'INSURANCE', basis: 'STANDARD', scope: 'SELF' };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

/** Leaf triple in the export's shape (Double|Null at every leaf). */
const leaf = (mtd: number | null, qtd: number | null, ytd: number | null) => ({ mtd, qtd, ytd });
/**
 * Variant object as exported: its own period leaves plus the four product leaves. Numbers come from a Group row on
 * the development cluster (numeric fields only): `mtd` equals linked + regular + psa + sp, and
 * `snapshot.tpc.withoutRepricing.creditPoint` (1,983.60) equals 10% × (PSA + SP).
 */
const variant = (total: ReturnType<typeof leaf>, products: Record<'linked' | 'regular' | 'psa' | 'sp', ReturnType<typeof leaf>>) => ({ ...total, ...products });
const GROUP_TPC = variant(leaf(4284248.399999997, 10332488.880000062, 14629845.780000092), {
  linked: leaf(4146314.399999998, 7455434.3999999985, 11470044.960000025),
  regular: leaf(118097.99999999933, 1324345.679999991, 1593143.8199999898),
  psa: leaf(12636, 50500.79999999999, 62099.99999999997),
  sp: leaf(7200, 1502208, 1504557),
});
const WITH_REPRICING = variant(leaf(5000, 12000, 20000), {
  linked: leaf(4000, 9000, 15000), regular: leaf(500, 1500, 2500), psa: leaf(300, 900, 1500), sp: leaf(200, 600, 1000),
});
const period = { year: 2025, month: 6, quarter: 'Q2', yyyymm: '202506' };
const row = (overrides: Document = {}): Document => ({
  agentId: agent.agentId, agentAggregation: 'Personal', entity: 'PAMB', agentType: 'PAMB', agentStatus: 'Active', caseStatus: 'Collected',
  period, asOnDate: '2026-09-28T03:53:43Z',
  ptd: {
    tpc: { withoutRepricing: GROUP_TPC, withRepricing: WITH_REPRICING },
    ptpc: { withoutRepricing: variant(leaf(100, 200, 300), { linked: leaf(60, 120, 180), regular: leaf(20, 40, 60), psa: leaf(10, 20, 30), sp: leaf(10, 20, 30) }), withRepricing: WITH_REPRICING },
    fyp: variant(leaf(9566761.590000018, 20000000, 43788246.38999966), {
      linked: leaf(9079633.350000054, 17991149.669999994, 26311544.54999999),
      regular: leaf(242418.2399999988, 400000, 900000), psa: leaf(172710, 414306, 818100), sp: leaf(72000, 100000, 250000),
    }),
    fyc: { ytd: null }, caseCount: { total: leaf(3, 5, 9) },
  },
  ...overrides,
});
const hierarchy = (leaderId: string, tier: string): Document => ({
  _id: `h-${leaderId}`, asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') },
  hierarchy: { leaderId }, subtree: { scopeProfileIds: [leaderId] }, displayRows: { tier },
});
/** Identity over HTTP resolves from `my_agent_hierarchy`, so the caller needs a hierarchy row. */
const sourceOf = (rows: Document[]) => new PerformanceSource(
  fakeMongo({ my_production: rows, my_agent_hierarchy: [hierarchy(agent.agentId, 'Agent'), hierarchy(leader.agentId, 'AM')] }).dbs, agents,
);

describe('breakdown by product from my_production (S-P4-02, TPC/PTPC/FYP)', () => {
  it('maps every product leaf to a path that exists in the vendored my_production schema', () => {
    const schema = sourceSchema('my_production');
    for (const [code, mapping] of Object.entries(PERFORMANCE_BREAKDOWN_MAPPING)) {
      for (const base of Object.values(mapping.variants)) {
        for (const { leaf: name } of PERFORMANCE_PRODUCT_LEAVES) {
          for (const p of ['MTD', 'QTD', 'YTD'] as const) {
            const node = performanceProductPath(base, name, p).split('.').reduce<ReturnType<typeof sourceSchema> | undefined>((n, k) => n?.properties?.[k], schema);
            expect(node, `${code}: ${performanceProductPath(base, name, p)}`).toBeDefined();
          }
        }
      }
    }
    // The credit-point source is a snapshot-only value with no period leaf, so no mapping may point at it.
    const paths = Object.values(PERFORMANCE_BREAKDOWN_MAPPING).flatMap((m) => Object.values(m.variants));
    expect(paths.every((p) => p.startsWith('ptd.'))).toBe(true);
    expect(paths.join()).not.toMatch(/snapshot|creditPoint|credit_points/);
  });

  it('Credit Points = 10% × (PSA + Single Premium), equal to the stored snapshot value for the same month', () => {
    expect(creditPointAmount('12636.00', '7200.00', '4284248.40')).toBe('1983.60');
    // Capped at 25% of the product total when the weighted amount would exceed it (D-19).
    expect(creditPointAmount('1000.00', '1000.00', '500.00')).toBe('125.00');
  });

  it('reads the exact period leaf per period: rows, derived Credit Points, and a total that is the sum of the rows', () => {
    const ytd = productBreakdown(row(), 'ptd.tpc.withoutRepricing', 'YTD', 'WITHOUT_REPRICING', 'ALL', true)!;
    expect(ytd.columns).toEqual(['ALL']);
    expect(ytd.rows.map((r) => r.productCode)).toEqual(['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS']);
    const amounts = Object.fromEntries(ytd.rows.map((r) => [r.productCode, (r.cells[0]!.value as { amount: string }).amount]));
    expect(amounts).toEqual({
      LINKED_PREMIUM: '11470044.96', REGULAR_PREMIUM: '1593143.82', PSA: '62100.00', SINGLE_PREMIUM: '1504557.00',
      CREDIT_POINTS: '156665.70', // 10% × (62,100.00 + 1,504,557.00)
    });
    expect(ytd.totals).toEqual([{ businessLine: 'ALL', value: { kind: 'MONEY', amount: '14786511.48', currency: 'MYR' } }]);

    const mtd = productBreakdown(row(), 'ptd.tpc.withoutRepricing', 'MTD', 'WITHOUT_REPRICING', 'ALL', true)!;
    expect(mtd.rows.find((r) => r.productCode === 'LINKED_PREMIUM')!.cells[0]!.value).toMatchObject({ amount: '4146314.40' });
    expect(mtd.rows.find((r) => r.productCode === 'CREDIT_POINTS')!.cells[0]!.value).toMatchObject({ amount: '1983.60' });
  });

  it('only PSA and Single Premium carry the (10%) weight label; Credit Points does not (Figma 1:16115)', () => {
    const table = productBreakdown(row(), 'ptd.tpc.withoutRepricing', 'YTD', 'WITHOUT_REPRICING', 'ALL', true)!;
    expect(table.rows.map((r) => [r.productCode, r.weightPct])).toEqual([
      ['LINKED_PREMIUM', undefined], ['REGULAR_PREMIUM', undefined], ['PSA', 10], ['SINGLE_PREMIUM', 10], ['CREDIT_POINTS', undefined],
    ]);
  });

  it('a null leaf is absent, never zero; a real zero is kept; no usable leaf means no table', () => {
    const sparse = row({ ptd: { tpc: { withoutRepricing: variant(leaf(1, 1, 1), {
      linked: leaf(null, null, 500), regular: leaf(0, 0, 0), psa: leaf(null, null, null), sp: leaf(0, 0, 40) }) } } });
    const table = productBreakdown(sparse, 'ptd.tpc.withoutRepricing', 'YTD', 'WITHOUT_REPRICING', 'ALL', true)!;
    // PSA is null ⇒ no PSA row and, needing both weighted leaves, no Credit Points row either.
    expect(table.rows.map((r) => r.productCode)).toEqual(['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'SINGLE_PREMIUM']);
    expect(table.rows[1]!.cells[0]!.value).toEqual({ kind: 'MONEY', amount: '0.00', currency: 'MYR' });
    expect(table.totals[0]!.value).toMatchObject({ amount: '540.00' });
    expect(productBreakdown(sparse, 'ptd.tpc.withoutRepricing', 'MTD', 'WITHOUT_REPRICING', 'ALL', true)!.rows.map((r) => r.productCode)).toEqual(['REGULAR_PREMIUM', 'SINGLE_PREMIUM']);
    expect(productBreakdown(row({ ptd: { tpc: { withoutRepricing: { ytd: 5 } } } }), 'ptd.tpc.withoutRepricing', 'YTD', 'WITHOUT_REPRICING', 'ALL', true)).toBeUndefined();
    expect(productBreakdown(undefined, 'ptd.tpc.withoutRepricing', 'YTD', 'WITHOUT_REPRICING', 'ALL', true)).toBeUndefined();
  });

  it('TPC and PTPC emit both variants, FYP one without Credit Points, other metrics none', () => {
    const r = row();
    const tpc = metricBreakdowns('TPC', r, 'YTD', 'INSURANCE');
    expect(tpc.map((t) => t.variant)).toEqual(['WITHOUT_REPRICING', 'WITH_REPRICING']);
    expect(tpc[1]!.rows.map((x) => x.productCode)).toContain('CREDIT_POINTS');
    expect(metricBreakdowns('PTPC', r, 'YTD', 'INSURANCE').map((t) => t.variant)).toEqual(['WITHOUT_REPRICING', 'WITH_REPRICING']);
    const fyp = metricBreakdowns('FYP', r, 'YTD', 'TAKAFUL');
    expect(fyp).toHaveLength(1);
    expect(fyp[0]!.columns).toEqual(['TAKAFUL']);
    expect(fyp[0]!.rows.map((x) => x.productCode)).toEqual(['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM']); // no UNIT_TRUST/GROUP_PREMIUM/CREDIT_POINTS source
    for (const code of ['CASE_COUNT', 'FYC', 'MANPOWER', 'NOPE']) expect(metricBreakdowns(code, r, 'YTD', 'ALL')).toEqual([]);
  });
});

describe('domain metricDetail carries the breakdown (insights.v1 getAgentMetricDetail)', () => {
  it('TPC detail returns both variant tables for the headline period, FYP returns one', async () => {
    const source = sourceOf([row()]);
    const tpc = await source.metricDetail(agent, 'TPC', lens);
    expect(tpc?.breakdowns?.map((b) => b.variant)).toEqual(['WITHOUT_REPRICING', 'WITH_REPRICING']);
    expect(tpc?.breakdowns?.[0]?.totals[0]?.value).toMatchObject({ amount: '14786511.48' });
    expect(tpc?.breakdowns?.[1]?.rows.map((r) => r.productCode)).toEqual(['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS']);

    const mtd = await source.metricDetail(agent, 'TPC', { ...lens, period: 'MTD' });
    expect(mtd?.breakdowns?.[0]?.rows[0]?.cells[0]?.value).toMatchObject({ amount: '4146314.40' });

    const fyp = await source.metricDetail(agent, 'FYP', lens);
    expect(fyp?.breakdowns).toHaveLength(1);
    expect(fyp?.breakdowns?.[0]?.rows).toHaveLength(4);
    expect((await source.metricDetail(agent, 'CASE_COUNT', lens))?.breakdowns).toBeUndefined();
  });

  it('follows the request: TEAM reads its own aggregation row; EMPTY headline ⇒ no breakdown', async () => {
    const group = row({ agentId: leader.agentId, agentAggregation: 'Group', ptd: { tpc: { withoutRepricing: variant(leaf(10, 10, 10), {
      linked: leaf(4, 4, 4), regular: leaf(3, 3, 3), psa: leaf(2, 2, 2), sp: leaf(1, 1, 1) }) } } });
    const source = sourceOf([row(), group]);
    const team = await source.metricDetail(leader, 'TPC', { ...lens, scope: 'TEAM', teamView: 'GROUP' });
    expect(team?.breakdowns?.map((b) => b.variant)).toEqual(['WITHOUT_REPRICING']); // no repriced leaves on that row
    expect(team?.breakdowns?.[0]?.totals[0]?.value).toMatchObject({ amount: '10.30' }); // 4 + 3 + 2 + 1 + Credit Points 0.30

    const noHeadline = row({ ptd: { tpc: { withoutRepricing: variant(leaf(null, null, null), { linked: leaf(1, 1, 1), regular: leaf(1, 1, 1), psa: leaf(1, 1, 1), sp: leaf(1, 1, 1) }) } } });
    const empty = await sourceOf([noHeadline]).metricDetail(agent, 'TPC', lens);
    expect(empty?.dataState).toBe('EMPTY');
    expect(empty?.breakdowns).toBeUndefined();
  });
});

describe('BFF composes the breakdown sections from the domain', () => {
  it('TPC: gauge, comparison, with-repricing value and both breakdown tables, in config order', async () => {
    const app = buildApp(sourceOf([row()])); apps.push(app);
    const res = await app.inject({ url: '/api/bff/v1/performance/metrics/TPC?period=YTD&businessLine=INSURANCE&scope=SELF', headers: { 'x-agent-id': agent.agentId } });
    expect(res.statusCode).toBe(200);
    const vm = res.json();
    expect(vm.dataState).toBe('OK');
    expect(vm.sections.map((s: { id: string }) => s.id)).toEqual([
      'gauge.primary', 'comparison.primary', 'variant.with-repricing', 'breakdown.without-repricing', 'breakdown.with-repricing',
    ]);
    const without = vm.sections.find((s: { id: string }) => s.id === 'breakdown.without-repricing');
    expect(without).toMatchObject({ type: 'BREAKDOWN', variant: 'WITHOUT_REPRICING', columns: ['INSURANCE'] });
    expect(without.rows.map((r: { productCode: string }) => r.productCode)).toEqual(['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS']);
    expect(without.totals).toEqual([{ businessLine: 'INSURANCE', value: { kind: 'MONEY', amount: '14786511.48', currency: 'MYR' } }]);
  });

  it('FYP: a single breakdown table, and a metric without product leaves simply has no breakdown section', async () => {
    const app = buildApp(sourceOf([row()])); apps.push(app);
    const fyp = (await app.inject({ url: '/api/bff/v1/performance/metrics/FYP?period=YTD&businessLine=ALL', headers: { 'x-agent-id': agent.agentId } })).json();
    expect(fyp.sections.filter((s: { type: string }) => s.type === 'BREAKDOWN')).toHaveLength(1);
    expect(fyp.sections.find((s: { type: string }) => s.type === 'BREAKDOWN').rows).toHaveLength(4);

    const bare = row({ ptd: { tpc: { withoutRepricing: { ytd: 4538.76, mtd: 0 }, withRepricing: { ytd: 12668.72, mtd: 8249.96 } }, fyp: { ytd: 21678.39 }, caseCount: { total: { ytd: 4 } } } });
    const app2 = buildApp(sourceOf([bare])); apps.push(app2);
    const tpc = (await app2.inject({ url: '/api/bff/v1/performance/metrics/TPC?period=YTD&businessLine=INSURANCE', headers: { 'x-agent-id': agent.agentId } })).json();
    expect(tpc.dataState).toBe('OK');
    expect(tpc.sections.some((s: { type: string }) => s.type === 'BREAKDOWN')).toBe(false);
  });
});
