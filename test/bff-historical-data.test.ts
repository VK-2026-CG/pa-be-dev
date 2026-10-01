import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { PerformanceSource } from '../src/data/performance-source.js';
import { createInsightsDomain } from '../src/bff/domain-client.js';
import { fakeMongo } from './support/mongo-fake.js';
import { composeHistoricalData, pctChangeOneDecimal, type HistoricalDataParams } from '../src/bff/compose/historical-data.js';
import { CONFIG } from '../src/bff/config.js';
import type { DomainApi, MonthlyHistoryParams } from '../src/bff/domain-client.js';
import type { Persona } from '../src/bff/persona.js';
import type { DeltaVM, HistoricalDataVM, MetricScalar } from '../vendor/spec/performance-vm.js';
import type { MonthlyHistory, MonthlyHistoryRecord, MonthlyMetricValue } from '../src/types.js';
import { BFF, getJson } from './support/bff-api.js';
import { personaHeaders, type PersonaKey } from './support/personas.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine

const NOW = new Date('2026-10-01T09:00:00Z');
const P2: Persona = { id: 'LEADER_P2', agentId: 'L3001', level: 'P2', label: 'P2' };
const money = (amount: string): MetricScalar => ({ kind: 'MONEY', amount, currency: 'MYR' });
const count = (value: number): MetricScalar => ({ kind: 'COUNT', value });
const percent = (value: number): MetricScalar => ({ kind: 'PERCENT', value });

type Source = 'PAMB' | 'PBTB';
interface RecordOptions {
  year: number; month: number; source?: Source; aggregation?: 'Personal' | 'DirectUnit' | 'Group';
  tpc?: string | null; tpcRe?: string | null; fyp?: string | null; fyc?: string | null; cases?: number | null;
  manpower?: number | null; activity?: number | null; productivity?: number | null; acs?: string | null; recruits?: number | null;
  production?: boolean; mapa?: boolean; asOn?: string;
}
const val = <T>(raw: T | null | undefined, make: (v: T) => MetricScalar): MetricScalar | null => raw === null || raw === undefined ? null : make(raw);
/** A domain `MonthlyHistoryRecord` with the contract metric lists. */
function rec(o: RecordOptions): MonthlyHistoryRecord {
  const asOnDate = o.asOn ?? `${o.year}-${String(o.month).padStart(2, '0')}-28`;
  const production: MonthlyMetricValue[] = [
    { metricCode: 'TPC', variant: 'WITHOUT_REPRICING', value: val(o.tpc, money) }, { metricCode: 'TPC', variant: 'WITH_REPRICING', value: val(o.tpcRe, money) },
    { metricCode: 'PTPC', variant: 'WITHOUT_REPRICING', value: money('1.00') }, { metricCode: 'PTPC', variant: 'WITH_REPRICING', value: money('1.00') },
    { metricCode: 'FYP', value: o.fyp === undefined ? money('2.00') : val(o.fyp, money) }, { metricCode: 'FYC', value: val(o.fyc, money) }, { metricCode: 'CASE_COUNT', value: val(o.cases, count) },
  ];
  const mapa: MonthlyMetricValue[] = [
    { metricCode: 'MANPOWER', value: val(o.manpower, count) }, { metricCode: 'ACTIVITY_RATIO', value: val(o.activity, percent) },
    { metricCode: 'PRODUCTIVITY', value: val(o.productivity, (v) => ({ kind: 'DECIMAL', value: v, precision: 1 })) },
    { metricCode: 'AVERAGE_CASE_SIZE', value: val(o.acs, money) }, { metricCode: 'NEW_RECRUIT_CONTRACTED', value: val(o.recruits, count) },
  ];
  return {
    period: `${o.year}-${String(o.month).padStart(2, '0')}`, year: o.year, month: o.month, source: o.source ?? 'PAMB', aggregation: o.aggregation ?? 'DirectUnit',
    production: o.production === false ? null : { asOnDate, monthEnd: true, metrics: production },
    mapa: o.mapa === false ? null : { asOnDate, monthEnd: true, metrics: mapa },
  };
}
function fakeDomain(records: MonthlyHistoryRecord[]) {
  const calls: Array<{ caller: string; agentId: string; params: MonthlyHistoryParams }> = [];
  const domain = {
    monthlyHistory: async (caller: string, agentId: string, params: MonthlyHistoryParams) => {
      calls.push({ caller, agentId, params });
      return { agentId, from: params.from, to: params.to, records };
    },
  } as unknown as DomainApi;
  return { domain, calls };
}
const base: HistoricalDataParams = { scope: 'TEAM', metricCode: 'TPC', variant: 'WITHOUT_REPRICING', comparison: 'CURRENT_YEAR', businessLine: 'ALL', teamView: 'DIRECT', basis: 'STANDARD' };
const compose = (records: MonthlyHistoryRecord[], over: Partial<HistoricalDataParams> = {}, now = NOW) => {
  const { domain, calls } = fakeDomain(records);
  return composeHistoricalData(domain, P2, { ...base, ...over }, now).then((vm) => ({ vm, calls }));
};
/** TPC (without repricing) per month for the anchor-year tests, keyed `${year}-${month}`. */
const tpcRecords = (values: Record<string, string | null>, source: Source = 'PAMB') =>
  Object.entries(values).map(([key, tpc]) => { const [year, month] = key.split('-').map(Number); return rec({ year: year!, month: month!, tpc, source }); });
const pct = (c: DeltaVM | null | undefined) => c ? [c.comparisonBasis, c.direction, c.sentiment, c.display, c.pct] : null;

describe('composeHistoricalData (ARVIJ-1450 · S-P4-03 v2.0.0)', () => {
  it('AC-P4-03-28 makes ONE domain read: 4 calendar years ending with the clock year (48 months), the persona agent, the teamView aggregation', async () => {
    const { calls } = await compose(tpcRecords({ '2026-01': '1.00' }));
    expect(calls).toEqual([{ caller: 'L3001', agentId: 'L3001', params: { from: '2023-01', to: '2026-12', aggregation: 'DirectUnit' } }]);
    expect((await compose([], { teamView: 'GROUP' })).calls[0]!.params.aggregation).toBe('Group');
    expect((await compose([], {}, new Date('2027-01-01T00:00:00Z'))).calls[0]!.params).toMatchObject({ from: '2024-01', to: '2027-12' });
    expect(CONFIG.screens.historicalData.lookbackYears * 12 + 12).toBe(48);
  });

  describe('AC-P4-03-20 current year: change against the previous month (Jira AC7)', () => {
    const records = tpcRecords({
      '2025-12': '20000.00', '2026-01': '25246.00', '2026-02': '7524.31', '2026-03': '12417.31', '2026-04': '12417.31', '2026-06': '5000.00',
    });

    it('computes ((cur - prior) / prior) * 100 to one decimal, with direction and sentiment from the rounded value', async () => {
      const { vm } = await compose(records);
      expect(vm.years).toEqual([2026]);
      expect(vm.changeColumns).toEqual([{ basis: 'LAST_MONTH' }]);
      const change = (m: number) => pct(vm.rows[m - 1]!.changes[0]);
      expect(change(2)).toEqual(['LAST_MONTH', 'DOWN', 'NEGATIVE', 'PCT', -70.2]);
      expect(change(3)).toEqual(['LAST_MONTH', 'UP', 'POSITIVE', 'PCT', 65]);
      expect(change(4)).toEqual(['LAST_MONTH', 'FLAT', 'NEUTRAL', 'PCT', 0]);
    });

    it('AC-P4-03-25 a month with no current value is N/A (null) and so is a month whose previous month has no value', async () => {
      const { vm } = await compose(records);
      expect(vm.rows[4]!.values).toEqual([null]); // May: no record
      expect(vm.rows[4]!.changes).toEqual([null]);
      expect(vm.rows[5]!.values).toEqual([money('5000.00')]); // June has a value but May (its previous month) does not
      expect(vm.rows[5]!.changes).toEqual([null]);
      expect(vm.rows.slice(6).every((r) => r.values[0] === null && r.changes[0] === null)).toBe(true);
    });

    it('AC-P4-03-31 January compares with the previous December', async () => {
      const { vm } = await compose(records);
      expect(pct(vm.rows[0]!.changes[0])).toEqual(['LAST_MONTH', 'UP', 'POSITIVE', 'PCT', 26.2]);
      // No previous December ⇒ N/A; a zero previous December ⇒ N/A (undefined %).
      expect((await compose(tpcRecords({ '2026-01': '10.00' }))).vm.rows[0]!.changes).toEqual([null]);
      expect((await compose(tpcRecords({ '2025-12': '0.00', '2026-01': '10.00' }))).vm.rows[0]!.changes).toEqual([null]);
      // A December two years back is not the previous month, and neither is January of last year.
      expect((await compose(tpcRecords({ '2024-12': '10.00', '2026-01': '10.00' }))).vm.rows[0]!.changes).toEqual([null]);
      expect((await compose(tpcRecords({ '2025-01': '10.00', '2026-01': '10.00' }))).vm.rows[0]!.changes).toEqual([null]);
    });

    it('AC-P4-03-31 February compares with January of the same year, not with last year', async () => {
      const { vm } = await compose(tpcRecords({ '2025-01': '1.00', '2025-02': '1.00', '2026-01': '200.00', '2026-02': '300.00' }));
      expect(vm.rows[1]!.changes[0]?.pct).toBe(50);
    });
  });

  it('AC-P4-03-20 AC-P4-03-21 AC-P4-03-22 only CURRENT_YEAR uses LAST_MONTH; VS_LAST_YEAR and VS_LAST_2_YEARS never do (every metric, rows and totals)', async () => {
    const records = [2024, 2025, 2026].flatMap((year) => [1, 2, 3, 4, 5, 6].map((month) => rec({
      year, month, tpc: `${year - 2000 + month}.00`, tpcRe: `${year - 2000 + month}.50`, cases: month + 1, manpower: 10 + month, activity: 60 + month, productivity: 2.5 + month / 10, acs: `${100 + month}.00`, recruits: month,
    })));
    for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] as const) {
      for (const m of CONFIG.screens.historicalData.metrics) {
        const { vm } = await compose(records, { metricCode: m.metricCode, variant: m.variant, comparison });
        const label = `${comparison} ${m.metricCode}${m.variant ? `/${m.variant}` : ''}`;
        const expected = comparison === 'CURRENT_YEAR' ? ['LAST_MONTH'] : comparison === 'VS_LAST_YEAR' ? ['LAST_YEAR'] : ['LAST_YEAR', 'LAST_2_YEARS'];
        expect(vm.changeColumns.map((c) => c.basis), label).toEqual(expected);
        const deltas = [...vm.rows.flatMap((r) => r.changes), ...(vm.totals?.changes ?? [])].filter((c): c is DeltaVM => c !== null);
        expect(deltas.length, label).toBeGreaterThan(0);
        expect(new Set(deltas.map((d) => d.comparisonBasis)), label).toEqual(new Set(deltas.length && comparison === 'VS_LAST_2_YEARS' ? ['LAST_YEAR', 'LAST_2_YEARS'] : [expected[0]]));
        if (comparison !== 'CURRENT_YEAR') expect(JSON.stringify(vm), label).not.toContain('LAST_MONTH');
      }
    }
  });

  describe('AC-P4-03-21 vs last year', () => {
    it('shows [A, A-1] and one LAST_YEAR change per month against the same month of the previous year', async () => {
      const { vm } = await compose(tpcRecords({ '2025-01': '100.00', '2025-02': '100.00', '2025-03': '100.00', '2026-01': '150.00', '2026-02': '50.00', '2026-03': '100.00' }), { comparison: 'VS_LAST_YEAR' });
      expect(vm.years).toEqual([2026, 2025]);
      expect(vm.changeColumns).toEqual([{ basis: 'LAST_YEAR' }]);
      expect(vm.rows[0]!.values).toEqual([money('150.00'), money('100.00')]);
      expect(vm.rows.slice(0, 3).map((r) => pct(r.changes[0]))).toEqual([
        ['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 50], ['LAST_YEAR', 'DOWN', 'NEGATIVE', 'PCT', -50], ['LAST_YEAR', 'FLAT', 'NEUTRAL', 'PCT', 0],
      ]);
    });

    it('AC-P4-03-25 January is compared with January, not December; no prior-year value is N/A but the current value still shows', async () => {
      const { vm } = await compose(tpcRecords({ '2025-12': '1.00', '2026-01': '2.00', '2026-02': '3.00' }), { comparison: 'VS_LAST_YEAR' });
      expect(vm.rows[0]!.changes).toEqual([null]);
      expect(vm.rows[1]!.values).toEqual([money('3.00'), null]);
      expect(vm.rows[1]!.changes).toEqual([null]);
    });
  });

  describe('AC-P4-03-22 vs last 2 years', () => {
    const records = tpcRecords({ '2024-03': '200.00', '2025-03': '100.00', '2026-03': '150.00', '2025-04': '10.00', '2026-04': '30.00' });
    it('shows [A, A-1, A-2] with a LAST_YEAR and a LAST_2_YEARS change per month', async () => {
      const { vm } = await compose(records, { comparison: 'VS_LAST_2_YEARS' });
      expect(vm.years).toEqual([2026, 2025, 2024]);
      expect(vm.changeColumns).toEqual([{ basis: 'LAST_YEAR' }, { basis: 'LAST_2_YEARS' }]);
      expect(vm.rows[2]!.values).toEqual([money('150.00'), money('100.00'), money('200.00')]);
      expect(vm.rows[2]!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 50], ['LAST_2_YEARS', 'DOWN', 'NEGATIVE', 'PCT', -25]]);
    });
    it('AC-P4-03-25 each change column is N/A independently (the other column survives)', async () => {
      const { vm } = await compose(records, { comparison: 'VS_LAST_2_YEARS' });
      expect(vm.rows[3]!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 200], null]);
      expect(vm.rows[3]!.values).toEqual([money('30.00'), money('10.00'), null]);
    });
  });

  describe('AC-P4-03-25 N/A rules', () => {
    it('no current value ⇒ N/A in every change column, while the historical values are still shown', async () => {
      const { vm } = await compose(tpcRecords({ '2024-05': '5.00', '2025-05': '6.00', '2025-04': '1.00', '2026-01': '9.00' }), { comparison: 'VS_LAST_2_YEARS' });
      expect(vm.rows[4]!.values).toEqual([null, money('6.00'), money('5.00')]);
      expect(vm.rows[4]!.changes).toEqual([null, null]);
      expect(vm.dataState).toBe('OK');
    });
    it('a zero prior has no percentage ⇒ N/A; a zero current against a positive prior is -100.0%', async () => {
      const { vm } = await compose(tpcRecords({ '2025-01': '0.00', '2026-01': '10.00', '2025-02': '10.00', '2026-02': '0.00' }), { comparison: 'VS_LAST_YEAR' });
      expect(vm.rows[0]!.changes).toEqual([null]);
      expect(pct(vm.rows[1]!.changes[0])).toEqual(['LAST_YEAR', 'DOWN', 'NEGATIVE', 'PCT', -100]);
      expect(vm.rows[0]!.values).toEqual([money('10.00'), money('0.00')]); // zero is a value, not a gap
    });
    it('a null metric value in a record is a gap, the same as a missing record', async () => {
      const { vm } = await compose([rec({ year: 2026, month: 1, tpc: null }), rec({ year: 2026, month: 2, tpc: '5.00' })]);
      expect(vm.rows[0]!.values).toEqual([null]);
      expect(vm.rows[1]!.changes).toEqual([null]);
    });
  });

  describe('percentage math (one decimal, half away from zero, exact)', () => {
    it('AC-P4-03-20 rounds half away from zero on both signs (not toward +infinity, not the integer R-PCT-ROUNDUP rule)', () => {
      expect(pctChangeOneDecimal(money('2001.00'), money('2000.00'))).toBe(0.1); // +0.05
      expect(pctChangeOneDecimal(money('1999.00'), money('2000.00'))).toBe(-0.1); // -0.05 (Math.round would give -0)
      expect(pctChangeOneDecimal(money('2000.80'), money('2000.00'))).toBe(0); // +0.04
      expect(pctChangeOneDecimal(money('1999.20'), money('2000.00'))).toBe(0); // -0.04, and 0 is not -0
      expect(Object.is(pctChangeOneDecimal(money('1999.20'), money('2000.00')), 0)).toBe(true);
      expect(pctChangeOneDecimal(money('100.00'), money('300.00'))).toBe(-66.7);
      expect(pctChangeOneDecimal(money('200.00'), money('300.00'))).toBe(-33.3);
      expect(pctChangeOneDecimal(money('1234.56'), money('1000.00'))).toBe(23.5); // 23.456
      expect(pctChangeOneDecimal(money('7524.31'), money('25246.00'))).toBe(-70.2);
    });
    it('AC-P4-03-20 MONEY uses integer cents: float-hostile values stay exact', () => {
      expect(pctChangeOneDecimal(money('0.30'), money('0.10'))).toBe(200);
      expect(pctChangeOneDecimal(money('1.15'), money('1.00'))).toBe(15);
      expect(pctChangeOneDecimal(money('999999999999999.99'), money('999999999999999.98'))).toBe(0);
      expect(pctChangeOneDecimal(money('999999999999999.99'), money('500000000000000.00'))).toBe(100);
      expect(pctChangeOneDecimal(money('-5.00'), money('-10.00'))).toBe(-50); // -5 vs -10: (−5+10)/−10 = −50%
    });
    it('AC-P4-03-20 COUNT, DECIMAL and PERCENT use exact decimal arithmetic', () => {
      expect(pctChangeOneDecimal(count(3), count(2))).toBe(50);
      expect(pctChangeOneDecimal(count(1), count(3))).toBe(-66.7);
      expect(pctChangeOneDecimal(percent(0.3), percent(0.1))).toBe(200);
      expect(pctChangeOneDecimal({ kind: 'DECIMAL', value: 9.7, precision: 1 }, { kind: 'DECIMAL', value: 9.3, precision: 1 })).toBe(4.3);
      expect(pctChangeOneDecimal(percent(1e-7), percent(2e-7))).toBe(-50);
      expect(pctChangeOneDecimal(count(5), count(0))).toBeNull();
      expect(pctChangeOneDecimal(money('1.00'), count(1))).toBeNull();
      expect(pctChangeOneDecimal(percent(Number.NaN), percent(1))).toBeNull();
    });
    it('AC-P4-03-20 ACTIVITY_RATIO is a relative % of the ratio, not percentage points', async () => {
      const { vm } = await compose([rec({ year: 2026, month: 1, activity: 64 }), rec({ year: 2026, month: 2, activity: 80 })], { metricCode: 'ACTIVITY_RATIO', variant: undefined });
      expect(pct(vm.rows[1]!.changes[0])).toEqual(['LAST_MONTH', 'UP', 'POSITIVE', 'PCT', 25]);
      expect(vm.valueType).toBe('PERCENT');
    });
  });

  describe('AC-P4-03-23 metric switching reads the selected metric from its owning collection', () => {
    const records = [
      rec({ year: 2026, month: 3, tpc: '10.00', tpcRe: '12.00', cases: 7, manpower: 25, activity: 82.5, productivity: 3.5, acs: '1500.00', recruits: 4 }),
    ];
    const expected: Array<[string, string | undefined, MetricScalar, string]> = [
      ['TPC', 'WITHOUT_REPRICING', money('10.00'), 'MONEY'], ['TPC', 'WITH_REPRICING', money('12.00'), 'MONEY'], ['CASE_COUNT', undefined, count(7), 'COUNT'],
      ['MANPOWER', undefined, count(25), 'COUNT'], ['ACTIVITY_RATIO', undefined, percent(82.5), 'PERCENT'],
      ['PRODUCTIVITY', undefined, { kind: 'DECIMAL', value: 3.5, precision: 1 }, 'DECIMAL'], ['AVERAGE_CASE_SIZE', undefined, money('1500.00'), 'MONEY'],
      ['NEW_RECRUIT_CONTRACTED', undefined, count(4), 'COUNT'],
    ];
    for (const [metricCode, variant, value, valueType] of expected) {
      it(`${metricCode}${variant ? ` / ${variant}` : ''}`, async () => {
        const { vm } = await compose(records, { metricCode, variant: variant as HistoricalDataParams['variant'] });
        expect(vm.rows[2]!.values).toEqual([value]);
        expect(vm.valueType).toBe(valueType);
        expect(vm.selection).toEqual({ metricCode, ...(variant ? { variant } : {}), comparison: 'CURRENT_YEAR' });
        expect(vm.filter.metrics.filter((m) => m.selected)).toEqual([{ metricCode, ...(variant ? { variant } : {}), selected: true }]);
      });
    }
    it('the config lists exactly these 8 metrics, in Figma order, and the selected one is flagged', async () => {
      expect(expected.map(([c, v]) => [c, v])).toEqual(CONFIG.screens.historicalData.metrics.map((m) => [m.metricCode, m.variant]));
    });
  });

  describe('AC-P4-03-30 businessLine selects the source database; nothing is summed across sources', () => {
    const records = [
      ...tpcRecords({ '2026-01': '100.00', '2026-02': '110.00' }, 'PAMB'),
      ...tpcRecords({ '2026-01': '20.00', '2025-12': '10.00', '2025-01': '1.00' }, 'PBTB'),
    ];
    it('INSURANCE and ALL read PAMB', async () => {
      for (const businessLine of ['INSURANCE', 'ALL'] as const) {
        const { vm } = await compose(records, { businessLine });
        expect(vm.rows[0]!.values).toEqual([money('100.00')]);
        expect(vm.context.businessLine).toBe(businessLine);
      }
    });
    it('TAKAFUL reads PBTB (its own January-vs-December pair)', async () => {
      const { vm } = await compose(records, { businessLine: 'TAKAFUL' });
      expect(vm.rows[0]!.values).toEqual([money('20.00')]);
      expect(pct(vm.rows[0]!.changes[0])).toEqual(['LAST_MONTH', 'UP', 'POSITIVE', 'PCT', 100]);
      expect(vm.rows[1]!.values).toEqual([null]);
    });
    it('the anchor year and asOfDate come from the chosen source only', async () => {
      const mixed = [rec({ year: 2025, month: 11, tpc: '1.00', asOn: '2025-11-30' }), rec({ year: 2026, month: 2, tpc: '2.00', source: 'PBTB', asOn: '2026-02-28' })];
      const pamb = (await compose(mixed, { businessLine: 'INSURANCE' })).vm;
      expect([pamb.anchorYear, pamb.years, pamb.meta.asOfDate]).toEqual([2025, [2025], '2025-11-30']);
      const pbtb = (await compose(mixed, { businessLine: 'TAKAFUL' })).vm;
      expect([pbtb.anchorYear, pbtb.meta.asOfDate]).toEqual([2026, '2026-02-28']);
    });
    it('the chosen source having no data is EMPTY even when the other source has data (anchor = clock year)', async () => {
      const { vm } = await compose(tpcRecords({ '2026-01': '5.00' }, 'PAMB'), { businessLine: 'TAKAFUL' });
      expect(vm.dataState).toBe('EMPTY');
      expect(vm.anchorYear).toBe(2026);
      expect(vm.meta.asOfDate).toBe('2026-10-01');
    });
  });

  describe('anchor year', () => {
    it('AC-P4-03-18 is the year of the newest record, so year columns follow the data, not the clock', async () => {
      const { vm } = await compose(tpcRecords({ '2024-05': '1.00', '2025-11': '2.00' }), { comparison: 'VS_LAST_2_YEARS' });
      expect(vm.anchorYear).toBe(2025);
      expect(vm.years).toEqual([2025, 2024, 2023]);
      expect(vm.rows[4]!.values).toEqual([null, money('1.00'), null]);
    });
    it('a record whose owning collection has no part still anchors (any collection), and then the metric is simply empty', async () => {
      const { vm } = await compose([rec({ year: 2026, month: 3, tpc: '1.00', mapa: false })], { metricCode: 'MANPOWER', variant: undefined });
      expect(vm.anchorYear).toBe(2026);
      expect(vm.dataState).toBe('EMPTY');
    });
  });

  describe('AC-P4-03-26 / AC-P4-03-27 no data (including a new agent)', () => {
    it('is EMPTY with the full table frame: 12 rows Jan..Dec, columns per comparison, the filter and no invented values', async () => {
      for (const [comparison, columns, changes] of [['CURRENT_YEAR', 1, 1], ['VS_LAST_YEAR', 2, 1], ['VS_LAST_2_YEARS', 3, 2]] as const) {
        const { vm } = await compose([], { comparison });
        expect(vm.dataState).toBe('EMPTY');
        expect(vm.rows.map((r) => r.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect(vm.rows.every((r) => r.values.length === columns && r.values.every((v) => v === null) && r.changes.length === changes && r.changes.every((c) => c === null))).toBe(true);
        expect(vm.years).toHaveLength(columns);
        expect(vm.changeColumns).toHaveLength(changes);
        expect(vm.anchorYear).toBe(2026);
        expect(vm.filter.metrics).toHaveLength(8);
        expect(vm.filter.comparisons.map((c) => c.comparison)).toEqual(['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS']);
        expect(vm.meta).toMatchObject({ screenId: 'S-P4-03', asOfDate: '2026-10-01', partial: false });
      }
    });
    it('is EMPTY when every cell of the selected metric is null although other metrics have data', async () => {
      const { vm } = await compose([rec({ year: 2026, month: 1, tpc: '5.00', cases: null })], { metricCode: 'CASE_COUNT', variant: undefined });
      expect(vm.dataState).toBe('EMPTY');
      expect((await compose([rec({ year: 2026, month: 1, tpc: '5.00' })])).vm.dataState).toBe('OK');
    });
  });

  it('AC-P4-03-15 AC-P4-03-17 the filter lists the 3 comparisons and flags the selected one; the table follows it', async () => {
    for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] as const) {
      const { vm } = await compose(tpcRecords({ '2026-01': '1.00' }), { comparison });
      expect(vm.filter.comparisons).toEqual((['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] as const).map((c) => ({ comparison: c, selected: c === comparison })));
      expect(vm.selection.comparison).toBe(comparison);
    }
  });

  it('AC-P4-03-19 the VM carries the context and a unique 12-row table', async () => {
    const { vm } = await compose(tpcRecords({ '2026-01': '1.00' }), { teamView: 'GROUP', businessLine: 'TAKAFUL' });
    expect(vm.context).toEqual({ businessLine: 'TAKAFUL', basis: 'STANDARD', scope: 'TEAM', teamView: 'GROUP' });
    expect(vm.rows).toHaveLength(12);
    expect(new Set(vm.rows.map((r) => r.month)).size).toBe(12);
  });
});

describe('AC-P4-03-32 desktop Total row (like-for-like, additive metrics only)', () => {
  const months = (year: number, upTo: number, amount: string, from = 1) => Array.from({ length: upTo - from + 1 }, (_, i) => [`${year}-${from + i}`, amount] as const);
  const rowsOf = (...groups: Array<ReadonlyArray<readonly [string, string | null]>>) => tpcRecords(Object.fromEntries(groups.flat()));
  const total = async (records: MonthlyHistoryRecord[], over: Partial<HistoricalDataParams> = {}) => (await compose(records, over)).vm.totals;

  it('sums only the months in which the anchor year has a value: the prior total covers Jan..Sep, not Jan..Dec', async () => {
    const t = await total(rowsOf(months(2026, 9, '100.00'), months(2025, 12, '50.00')), { comparison: 'VS_LAST_YEAR' });
    expect(t!.values).toEqual([money('900.00'), money('450.00')]); // 9 x 100 vs 9 x 50 (Oct..Dec of 2025 are left out)
    expect(t!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 100]]);
  });

  it('a month where the anchor year has no value is left out for every year (equal periods)', async () => {
    const t = await total(rowsOf([['2026-1', '100.00'], ['2026-3', '100.00'], ['2025-1', '10.00'], ['2025-2', '999.00'], ['2025-3', '10.00']]), { comparison: 'VS_LAST_YEAR' });
    expect(t!.values).toEqual([money('200.00'), money('20.00')]);
  });

  it('a prior year missing one month of the anchor range has a null total and a null change (never a partial sum)', async () => {
    const records = rowsOf(months(2026, 9, '100.00'), months(2025, 9, '50.00').filter(([k]) => k !== '2025-4'), months(2024, 9, '25.00'));
    const t = await total(records, { comparison: 'VS_LAST_2_YEARS' });
    expect(t!.values).toEqual([money('900.00'), null, money('225.00')]);
    expect(t!.changes.map(pct)).toEqual([null, ['LAST_2_YEARS', 'UP', 'POSITIVE', 'PCT', 300]]);
  });

  it('a prior value that is null in the source counts as missing', async () => {
    const t = await total(rowsOf(months(2026, 2, '1.00'), [['2025-1', '1.00'], ['2025-2', null]]), { comparison: 'VS_LAST_YEAR' });
    expect(t!.values).toEqual([money('2.00'), null]);
    expect(t!.changes).toEqual([null]);
  });

  it('CURRENT_YEAR gives one value (the anchor total) and a null change: a month-over-month change of a total is undefined', async () => {
    const vm = (await compose(rowsOf(months(2026, 4, '25.00'), months(2025, 12, '1.00')), { comparison: 'CURRENT_YEAR' })).vm;
    expect(vm.changeColumns).toEqual([{ basis: 'LAST_MONTH' }]);
    expect(vm.totals).toEqual({ values: [money('100.00')], changes: [null] });
    // Even with a complete like-for-like last year, the LAST_MONTH column of the Total row stays empty.
    const full = (await compose(rowsOf(months(2026, 4, '25.00'), months(2025, 4, '10.00')), { comparison: 'CURRENT_YEAR' })).vm;
    expect(full.totals!.changes).toEqual([null]);
    expect(full.totals!.values).toHaveLength(full.years.length);
  });

  it('the LAST_YEAR / LAST_2_YEARS total changes are unaffected by the CURRENT_YEAR rule', async () => {
    const t = await total(rowsOf(months(2026, 4, '25.00'), months(2025, 4, '10.00'), months(2024, 4, '50.00')), { comparison: 'VS_LAST_2_YEARS' });
    expect(t!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 150], ['LAST_2_YEARS', 'DOWN', 'NEGATIVE', 'PCT', -50]]);
  });

  it('VS_LAST_2_YEARS gives two changes, LAST_YEAR then LAST_2_YEARS, each against its own year', async () => {
    const t = await total(rowsOf(months(2026, 3, '10.00'), months(2025, 3, '20.00'), months(2024, 3, '5.00')), { comparison: 'VS_LAST_2_YEARS' });
    expect(t!.values).toEqual([money('30.00'), money('60.00'), money('15.00')]);
    expect(t!.changes.map(pct)).toEqual([['LAST_YEAR', 'DOWN', 'NEGATIVE', 'PCT', -50], ['LAST_2_YEARS', 'UP', 'POSITIVE', 'PCT', 100]]);
  });

  it('a zero prior total gives a null change (undefined %), a zero anchor total against a positive prior is -100.0%, and a flat total is 0 / FLAT', async () => {
    const zero = await total(rowsOf(months(2026, 2, '5.00'), months(2025, 2, '0.00')), { comparison: 'VS_LAST_YEAR' });
    expect(zero!.values).toEqual([money('10.00'), money('0.00')]); // zero is a value, not a gap
    expect(zero!.changes).toEqual([null]);
    const toZero = await total(rowsOf(months(2026, 2, '0.00'), months(2025, 2, '5.00')), { comparison: 'VS_LAST_YEAR' });
    expect(toZero!.changes.map(pct)).toEqual([['LAST_YEAR', 'DOWN', 'NEGATIVE', 'PCT', -100]]);
    const flat = await total(rowsOf(months(2026, 2, '5.00'), months(2025, 2, '5.00')), { comparison: 'VS_LAST_YEAR' });
    expect(flat!.changes.map(pct)).toEqual([['LAST_YEAR', 'FLAT', 'NEUTRAL', 'PCT', 0]]);
  });

  it('no prior-year data at all gives null values and null changes while the anchor total is still present', async () => {
    const t = await total(rowsOf(months(2026, 3, '10.00')), { comparison: 'VS_LAST_2_YEARS' });
    expect(t).toEqual({ values: [money('30.00'), null, null], changes: [null, null] });
  });

  it('money is summed on integer cents: 0.10 + 0.20 is exactly 0.30, and float-hostile sums stay exact', async () => {
    const t = await total(rowsOf([['2026-1', '0.10'], ['2026-2', '0.20'], ['2025-1', '0.10'], ['2025-2', '0.10']]), { comparison: 'VS_LAST_YEAR' });
    expect(t!.values).toEqual([money('0.30'), money('0.20')]);
    expect(t!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 50]]);
    const wide = await total(rowsOf(months(2026, 12, '0.07')), { comparison: 'CURRENT_YEAR' });
    expect(wide!.values).toEqual([money('0.84')]);
    const big = await total(rowsOf([['2026-1', '999999999999.99'], ['2026-2', '0.01']]), { comparison: 'CURRENT_YEAR' });
    expect(big!.values).toEqual([money('1000000000000.00')]);
  });

  it('counts are summed as integers (CASE_COUNT, NEW_RECRUIT_CONTRACTED), with a count result of the same kind', async () => {
    const records = [rec({ year: 2026, month: 1, cases: 3, recruits: 2 }), rec({ year: 2026, month: 2, cases: 4, recruits: 0 }), rec({ year: 2025, month: 1, cases: 1, recruits: 1 }), rec({ year: 2025, month: 2, cases: 1, recruits: 0 }), rec({ year: 2025, month: 3, cases: 100, recruits: 100 })];
    const cases = (await compose(records, { metricCode: 'CASE_COUNT', variant: undefined, comparison: 'VS_LAST_YEAR' })).vm.totals;
    expect(cases!.values).toEqual([count(7), count(2)]);
    expect(cases!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 250]]);
    const recruits = (await compose(records, { metricCode: 'NEW_RECRUIT_CONTRACTED', variant: undefined, comparison: 'VS_LAST_YEAR' })).vm.totals;
    expect(recruits!.values).toEqual([count(2), count(1)]);
  });

  describe('which metrics carry totals', () => {
    const all = [rec({ year: 2026, month: 1, tpc: '1.00', tpcRe: '2.00', cases: 1, manpower: 5, activity: 70, productivity: 2.5, acs: '10.00', recruits: 1 })];
    const withTotals: Array<[string, HistoricalDataParams['variant']]> = [['TPC', 'WITHOUT_REPRICING'], ['TPC', 'WITH_REPRICING'], ['CASE_COUNT', undefined], ['NEW_RECRUIT_CONTRACTED', undefined]];
    for (const [metricCode, variant] of withTotals) {
      it(`${metricCode}${variant ? ` / ${variant}` : ''} has totals`, async () => {
        const { vm } = await compose(all, { metricCode, variant });
        expect(vm.totals).toBeDefined();
        expect(vm.totals!.values).toHaveLength(vm.years.length);
        expect(vm.totals!.changes).toHaveLength(vm.changeColumns.length);
        expect(vm.totals!.values[0]).not.toBeNull();
      });
    }
    for (const metricCode of ['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE']) {
      it(`${metricCode} never has a totals field (non-additive)`, async () => {
        for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] as const) {
          const { vm } = await compose(all, { metricCode, variant: undefined, comparison });
          expect('totals' in vm).toBe(false);
          expect(JSON.stringify(vm)).not.toContain('"totals"');
        }
      });
    }
    it('TPC with repricing totals its own series, not the without-repricing one', async () => {
      const { vm } = await compose([rec({ year: 2026, month: 1, tpc: '1.00', tpcRe: '2.00' }), rec({ year: 2026, month: 2, tpc: '1.00', tpcRe: '3.00' })], { variant: 'WITH_REPRICING' });
      expect(vm.totals!.values).toEqual([money('5.00')]);
    });
  });

  describe('EMPTY keeps the Total row (all null), and totals never affect dataState', () => {
    it('no data: totals present with null values and null changes for every comparison', async () => {
      for (const [comparison, columns, changes] of [['CURRENT_YEAR', 1, 1], ['VS_LAST_YEAR', 2, 1], ['VS_LAST_2_YEARS', 3, 2]] as const) {
        const { vm } = await compose([], { comparison });
        expect(vm.dataState).toBe('EMPTY');
        expect(vm.totals).toEqual({ values: Array(columns).fill(null), changes: Array(changes).fill(null) });
      }
    });
    it('TAKAFUL with a MAPA metric (no my_mapa in PBTB) is EMPTY: NEW_RECRUIT_CONTRACTED still has totals, all null', async () => {
      const records = [rec({ year: 2026, month: 1, source: 'PBTB', tpc: '5.00', mapa: false }), rec({ year: 2026, month: 2, source: 'PBTB', tpc: '6.00', mapa: false })];
      const { vm } = await compose(records, { businessLine: 'TAKAFUL', metricCode: 'NEW_RECRUIT_CONTRACTED', variant: undefined, comparison: 'VS_LAST_YEAR' });
      expect(vm.dataState).toBe('EMPTY');
      expect(vm.totals).toEqual({ values: [null, null], changes: [null] });
      // Its additive TPC on the same source is fine and not EMPTY.
      const tpc = (await compose(records, { businessLine: 'TAKAFUL' })).vm;
      expect([tpc.dataState, tpc.totals!.values]).toEqual(['OK', [money('11.00')]]);
    });
    it('the rows are unchanged by the totals (12 rows, same values and changes as before)', async () => {
      const { vm } = await compose(rowsOf(months(2026, 3, '10.00'), months(2025, 12, '5.00')), { comparison: 'VS_LAST_YEAR' });
      expect(vm.rows).toHaveLength(12);
      expect(vm.rows[2]!.values).toEqual([money('10.00'), money('5.00')]);
      expect(vm.rows[2]!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 100]]);
    });
  });

  it('over HTTP (memory stub): totals only for additive metrics; the anchor total is the sum of the shown months', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); // the route reads the wall clock for its 4-year window
    try {
      const vm = await getJson<HistoricalDataVM>(app, 'LEADER_P2', `${BFF}/performance/historical-data?comparison=VS_LAST_YEAR`);
      const shown = vm.rows.map((r) => r.values[0]).filter((v): v is MetricScalar => v !== null);
      const cents = shown.reduce((sum, v) => sum + (v.kind === 'MONEY' ? BigInt(v.amount.replace('.', '')) : 0n), 0n);
      expect(vm.totals!.values[0]).toEqual({ kind: 'MONEY', amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, currency: 'MYR' });
      expect(vm.totals!.values).toHaveLength(2);
      expect(vm.totals!.changes[0]?.comparisonBasis).toBe('LAST_YEAR');
      const mp = await getJson<Record<string, unknown>>(app, 'LEADER_P2', `${BFF}/performance/historical-data?metricCode=MANPOWER`);
      expect('totals' in mp).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('AC-P4-03-33 Self parity: the same screen for scope=SELF (compose)', () => {
  const SELF: Partial<HistoricalDataParams> = { scope: 'SELF', teamView: undefined };
  const personal = (o: Parameters<typeof rec>[0]) => rec({ aggregation: 'Personal', ...o });
  const SELF_METRICS: Array<[string, HistoricalDataParams['variant']]> = [['TPC', 'WITHOUT_REPRICING'], ['TPC', 'WITH_REPRICING'], ['CASE_COUNT', undefined], ['FYP', undefined], ['FYC', undefined]];
  const data = [2024, 2025, 2026].flatMap((year) => [1, 2, 3].map((month) => personal({ year, month, tpc: `${year - 2000 + month}.00`, tpcRe: `${year - 2000 + month}.50`, fyp: `${(year - 2000) * 10 + month}.00`, fyc: `${(year - 2000) * 5 + month}.00`, cases: month + (year - 2020) })));

  it('reads the Personal aggregation (one domain call), never DirectUnit or Group, whatever the teamView', async () => {
    for (const teamView of [undefined, 'DIRECT', 'GROUP'] as const) {
      const { calls } = await compose(data, { ...SELF, ...(teamView ? { teamView } : {}) });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params).toEqual({ from: '2023-01', to: '2026-12', aggregation: 'Personal' });
    }
  });

  it('only Personal records are used: DirectUnit and Group rows for the same months never leak into a SELF table', async () => {
    const mixed = [...data, ...tpcRecords({ '2026-01': '999.00' }).map((r) => ({ ...r, aggregation: 'Group' as const }))];
    const { vm } = await compose(mixed, { ...SELF, metricCode: 'TPC' });
    expect(vm.rows[0]!.values).toEqual([money('27.00')]);
    // A domain that ignored the aggregation filter and returned only DirectUnit rows leaves SELF empty (no fallback).
    expect((await compose(tpcRecords({ '2026-01': '5.00' }), { ...SELF })).vm.dataState).toBe('EMPTY');
  });

  it('the context is SELF with NO teamView key', async () => {
    const { vm } = await compose(data, { ...SELF, teamView: 'GROUP' });
    expect(vm.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
    expect('teamView' in vm.context).toBe(false);
    // TEAM keeps its teamView.
    expect((await compose(data, { teamView: 'GROUP' })).vm.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'TEAM', teamView: 'GROUP' });
  });

  it('the filter lists exactly the five self metrics in order, with the selected one flagged', async () => {
    const { vm } = await compose(data, { ...SELF, metricCode: 'FYP', variant: undefined });
    expect(vm.filter.metrics).toEqual([
      { metricCode: 'TPC', variant: 'WITHOUT_REPRICING', selected: false }, { metricCode: 'TPC', variant: 'WITH_REPRICING', selected: false },
      { metricCode: 'CASE_COUNT', selected: false }, { metricCode: 'FYP', selected: true }, { metricCode: 'FYC', selected: false },
    ]);
    expect(vm.selection).toEqual({ metricCode: 'FYP', comparison: 'CURRENT_YEAR' });
  });

  for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] as const) {
    it(`FYP and FYC work with ${comparison}: values, changes and the Total row`, async () => {
      for (const metricCode of ['FYP', 'FYC']) {
        const { vm } = await compose(data, { ...SELF, metricCode, variant: undefined, comparison });
        expect(vm.dataState, metricCode).toBe('OK');
        expect(vm.valueType).toBe('MONEY');
        expect(vm.rows).toHaveLength(12);
        expect(vm.years).toEqual(comparison === 'CURRENT_YEAR' ? [2026] : comparison === 'VS_LAST_YEAR' ? [2026, 2025] : [2026, 2025, 2024]);
        expect(vm.changeColumns.map((c) => c.basis)).toEqual(comparison === 'CURRENT_YEAR' ? ['LAST_MONTH'] : comparison === 'VS_LAST_YEAR' ? ['LAST_YEAR'] : ['LAST_YEAR', 'LAST_2_YEARS']);
        expect(vm.rows[1]!.changes.every((c) => c !== null)).toBe(true); // February: its previous month / same month of last year exist
        expect(vm.totals, metricCode).toBeDefined();
        expect(vm.totals!.values).toHaveLength(vm.years.length);
        expect(vm.totals!.changes).toHaveLength(vm.changeColumns.length);
        // The Total row has no month-over-month change; the year-over-year columns do.
        expect(vm.totals!.changes.every((c) => comparison === 'CURRENT_YEAR' ? c === null : c !== null)).toBe(true);
      }
    });
  }

  it('FYP arithmetic: Jan..Mar 2026 total vs 2025 total, same months only (like-for-like), one decimal', async () => {
    const { vm } = await compose(data, { ...SELF, metricCode: 'FYP', variant: undefined, comparison: 'VS_LAST_YEAR' });
    // FYP = (year-2000)*10 + month: 2026 -> 261+262+263 = 786; 2025 -> 251+252+253 = 756; +3.97% -> 4.0
    expect(vm.totals!.values).toEqual([money('786.00'), money('756.00')]);
    expect(vm.totals!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 4]]);
  });

  it('every one of the five self metrics has totals, and a SELF metric totals its own series (TPC with repricing, CASE_COUNT)', async () => {
    for (const [metricCode, variant] of SELF_METRICS) {
      const { vm } = await compose(data, { ...SELF, metricCode, variant });
      expect(vm.totals, metricCode).toBeDefined();
      expect(vm.totals!.values[0]).not.toBeNull();
    }
    expect((await compose(data, { ...SELF, variant: 'WITH_REPRICING' })).vm.totals!.values).toEqual([money('85.50')]);
    expect((await compose(data, { ...SELF, metricCode: 'CASE_COUNT', variant: undefined })).vm.totals!.values).toEqual([count(1 + 2 + 3 + 18)]);
  });

  it('businessLine still picks the source database for SELF (TAKAFUL -> PBTB Personal), and nothing is summed across sources', async () => {
    const records = [
      ...data.filter((r) => r.year === 2026),
      ...[1, 2, 3].map((month) => personal({ year: 2026, month, tpc: '1.00', source: 'PBTB' })),
    ];
    expect((await compose(records, { ...SELF, businessLine: 'TAKAFUL' })).vm.totals!.values).toEqual([money('3.00')]);
    expect((await compose(records, { ...SELF, businessLine: 'INSURANCE' })).vm.totals!.values).toEqual([money('84.00')]);
  });

  it('no data (a new agent): EMPTY with the full frame, and the Total row is present with null values and changes', async () => {
    const { vm } = await compose([], { ...SELF, metricCode: 'FYC', variant: undefined, comparison: 'VS_LAST_2_YEARS' });
    expect(vm.dataState).toBe('EMPTY');
    expect(vm.rows).toHaveLength(12);
    expect(vm.totals).toEqual({ values: [null, null, null], changes: [null, null] });
    expect(vm.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
  });

  it('a metric absent from the self list gets no total flag even if TEAM has one (config drives totals per scope)', async () => {
    // NEW_RECRUIT_CONTRACTED is totalable for TEAM but is not a SELF metric: composing it as SELF yields no Total row.
    const { vm } = await compose([personal({ year: 2026, month: 1, recruits: 2 })], { ...SELF, metricCode: 'NEW_RECRUIT_CONTRACTED', variant: undefined });
    expect('totals' in vm).toBe(false);
  });
});

describe('AC-P4-03-33 SELF over the Mongo source: the live query filters agentAggregation Personal', () => {
  const NOW_ = NOW;
  const row = (aggregation: string, year: number, month: number, fyp: number) => ({
    agentId: 'A9', agentAggregation: aggregation, entity: 'PAMB', caseStatus: 'Collected', asOnDate: '2026-09-29T00:00:00Z',
    period: { year, month, quarter: `Q${Math.ceil(month / 3)}`, yyyymm: `${year}${String(month).padStart(2, '0')}`, asOnMonthDay: 15 },
    ptd: { tpc: { withoutRepricing: { mtd: fyp } }, fyp: { mtd: fyp }, fyc: { mtd: null }, caseCount: { total: { mtd: 1 } } },
  });
  const hierarchy = { _id: 'h-A9', asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId: 'A9' }, subtree: { scopeProfileIds: [] }, displayRows: { tier: 'Agent' } };
  const live = async (over: Partial<HistoricalDataParams>) => {
    const m = fakeMongo({
      my_agent_hierarchy: [hierarchy],
      my_production: [row('Personal', 2026, 1, 10), row('DirectUnit', 2026, 1, 20), row('Group', 2026, 1, 30), row('Personal', 2025, 1, 5)],
    });
    const domain = createInsightsDomain(new PerformanceSource(m.dbs, new Map()));
    const vm = await composeHistoricalData(domain, { id: 'AGENT_P4', agentId: 'A9', level: 'P4', label: 'P4' }, { ...base, ...over }, NOW_);
    const history = m.pamb.requests.filter((r) => ['my_production', 'my_mapa'].includes(r.collection));
    return { vm, history, pbtb: m.pbtb.requests };
  };

  it('SELF queries only agentAggregation: Personal (both collections), never DirectUnit or Group, and returns the Personal values', async () => {
    const { vm, history, pbtb } = await live({ scope: 'SELF', teamView: undefined, metricCode: 'FYP', variant: undefined, comparison: 'VS_LAST_YEAR' });
    expect(history.map((r) => r.collection).sort()).toEqual(['my_mapa', 'my_production']);
    expect(history.every((r) => r.query.agentAggregation === 'Personal')).toBe(true);
    expect(pbtb.every((r) => r.query.agentAggregation === 'Personal')).toBe(true);
    expect(vm.rows[0]!.values).toEqual([money('10.00'), money('5.00')]);
    expect(vm.totals!.values).toEqual([money('10.00'), money('5.00')]);
    expect(vm.totals!.changes.map(pct)).toEqual([['LAST_YEAR', 'UP', 'POSITIVE', 'PCT', 100]]);
    expect(vm.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
  });

  it('TEAM keeps DirectUnit / Group by teamView (unchanged)', async () => {
    expect((await live({ metricCode: 'TPC' })).history.every((r) => r.query.agentAggregation === 'DirectUnit')).toBe(true);
    const group = await live({ teamView: 'GROUP', metricCode: 'TPC', variant: 'WITHOUT_REPRICING' });
    expect(group.history.every((r) => r.query.agentAggregation === 'Group')).toBe(true);
    expect(group.vm.rows[0]!.values).toEqual([money('30.00')]);
  });
});

describe('meta.asOfDate is an in-month as-on date, never the load watermark (Mongo source -> domain -> BFF)', () => {
  const WATERMARK = '2026-09-29T00:00:00Z';
  const row = (month: number, extra: Record<string, unknown>, collection: 'production' | 'mapa' = 'production') => ({
    agentId: 'L3001', agentAggregation: 'DirectUnit', entity: 'PAMB', caseStatus: 'Collected', asOnDate: collection === 'mapa' ? new Date(WATERMARK) : WATERMARK,
    period: { year: 2025, month, quarter: `Q${Math.ceil(month / 3)}`, yyyymm: `2025${String(month).padStart(2, '0')}`, ...extra },
    ptd: collection === 'production'
      ? { tpc: { withoutRepricing: { mtd: 100 + month } } }
      : { manpowerTotal: { mtd: 10 + month } },
  });
  // Identity resolves from the hierarchy (an AM snapshot for the caller).
  const hierarchy = { _id: 'h-L3001', asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId: 'L3001' }, subtree: { scopeProfileIds: [] }, displayRows: { tier: 'AM' } };
  const composeLive = async (pamb: Record<string, unknown[]>, businessLine: HistoricalDataParams['businessLine'] = 'ALL') => {
    const source = new PerformanceSource(fakeMongo({ my_agent_hierarchy: [hierarchy], ...pamb } as never).dbs, new Map());
    const domain = createInsightsDomain(source);
    return composeHistoricalData(domain, P2, { ...base, businessLine }, NOW);
  };

  it('AC-P4-03-26 the newest declared day (2025-07-12) is the as-of date although the watermark is 2026-09-29', async () => {
    const vm = await composeLive({ my_production: [row(5, { asOnMonthDay: 20 }), row(7, { asOnMonthDay: 12 })] });
    expect(vm.anchorYear).toBe(2025);
    expect(vm.meta.asOfDate).toBe('2025-07-12');
  });

  it('AC-P4-03-26 an undeclared day gives the month last day; the newest part of either collection wins', async () => {
    const vm = await composeLive({ my_production: [row(7, {})], my_mapa: [row(6, { asOnMonthDay: 29 }, 'mapa')] });
    expect(vm.meta.asOfDate).toBe('2025-07-31');
    const mapaNewest = await composeLive({ my_production: [row(6, { asOnMonthDay: 12 })], my_mapa: [row(8, { asOnMonthDay: 3 }, 'mapa')] });
    expect(mapaNewest.meta.asOfDate).toBe('2025-08-03');
  });

  it('AC-P4-03-26 no rows leaves the clock date (not a watermark)', async () => {
    expect((await composeLive({})).meta.asOfDate).toBe('2026-10-01');
  });
});

describe('S-P4-03 config (screens.historicalData)', () => {
  it('AC-P4-03-18 matches the contract: Figma metric order, three comparisons, defaults TPC without repricing + Current Year', () => {
    expect(CONFIG.screens.historicalData).toEqual({
      screenId: 'S-P4-03', scope: 'TEAM',
      metrics: [
        { metricCode: 'TPC', variant: 'WITHOUT_REPRICING', total: true }, { metricCode: 'TPC', variant: 'WITH_REPRICING', total: true }, { metricCode: 'CASE_COUNT', total: true },
        { metricCode: 'MANPOWER' }, { metricCode: 'ACTIVITY_RATIO' }, { metricCode: 'PRODUCTIVITY' }, { metricCode: 'AVERAGE_CASE_SIZE' }, { metricCode: 'NEW_RECRUIT_CONTRACTED', total: true },
      ],
      comparisons: ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'],
      defaultMetric: { metricCode: 'TPC', variant: 'WITHOUT_REPRICING' }, defaultComparison: 'CURRENT_YEAR', lookbackYears: 3,
      // The SELF scope of the same screen: its own metric set, all additive.
      self: {
        metrics: [
          { metricCode: 'TPC', variant: 'WITHOUT_REPRICING', total: true }, { metricCode: 'TPC', variant: 'WITH_REPRICING', total: true },
          { metricCode: 'CASE_COUNT', total: true }, { metricCode: 'FYP', total: true }, { metricCode: 'FYC', total: true },
        ],
        defaultMetric: { metricCode: 'TPC', variant: 'WITHOUT_REPRICING' },
      },
    });
  });
  it('the legacy SELF history block is untouched', () => {
    expect(CONFIG.screens.history).toMatchObject({ screenId: 'S-P4-03', defaultWindow: 'VS_LAST_2_YEARS', maxYearsBack: 4, windows: ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'] });
    expect(CONFIG.screens.history.tabs.SELF).toEqual(['TPC', 'CASE_COUNT', 'FYP', 'FYC']);
  });
});

const app = buildApp(await createSource());

describe('GET /api/bff/v1/performance/historical-data (memory source)', () => {
  const url = (query = '') => `${BFF}/performance/historical-data${query ? `?${query}` : ''}`;
  const status = async (persona: PersonaKey, query = '') => (await app.inject({ method: 'GET', url: url(query), headers: personaHeaders(persona) })).statusCode;
  const problem = async (persona: PersonaKey, query = '') => {
    const res = await app.inject({ method: 'GET', url: url(query), headers: personaHeaders(persona) });
    return { status: res.statusCode, code: res.json().code as string };
  };
  // The route reads the wall clock for the 4-year window; pin it so the stub (2023-01..2026-07) is always in range.
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterAll(() => { vi.useRealTimers(); });

  it('AC-P4-03-18 defaults to TPC without repricing, Current Year, ALL, DIRECT', async () => {
    const vm = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url());
    expect(vm.selection).toEqual({ metricCode: 'TPC', variant: 'WITHOUT_REPRICING', comparison: 'CURRENT_YEAR' });
    expect(vm.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'TEAM', teamView: 'DIRECT' });
    expect([vm.dataState, vm.valueType, vm.anchorYear, vm.years, vm.changeColumns]).toEqual(['OK', 'MONEY', 2026, [2026], [{ basis: 'LAST_MONTH' }]]);
    expect(vm.meta).toMatchObject({ screenId: 'S-P4-03', asOfDate: '2026-07-27', partial: false });
    expect(vm.rows).toHaveLength(12);
  });

  it('AC-P4-03-15 AC-P4-03-16 AC-P4-03-17 the filter lists the 8 metrics and 3 comparisons; the selection moves the flags', async () => {
    const vm = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url('metricCode=MANPOWER&comparison=VS_LAST_YEAR'));
    expect(vm.filter.metrics.map((m) => `${m.metricCode}${m.variant ? `/${m.variant}` : ''}${m.selected ? '*' : ''}`)).toEqual([
      'TPC/WITHOUT_REPRICING', 'TPC/WITH_REPRICING', 'CASE_COUNT', 'MANPOWER*', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE', 'NEW_RECRUIT_CONTRACTED',
    ]);
    expect(vm.filter.comparisons.find((c) => c.selected)?.comparison).toBe('VS_LAST_YEAR');
    expect(vm.selection).toEqual({ metricCode: 'MANPOWER', comparison: 'VS_LAST_YEAR' });
    expect([vm.valueType, vm.years, vm.changeColumns]).toEqual(['COUNT', [2026, 2025], [{ basis: 'LAST_YEAR' }]]);
  });

  it('AC-P4-03-23 switching the metric changes the values (variant defaults to WITHOUT_REPRICING; WITH_REPRICING is its own series)', async () => {
    const [without, withRepricing, implicit] = await Promise.all(['variant=WITHOUT_REPRICING', 'variant=WITH_REPRICING', ''].map((q) => getJson<HistoricalDataVM>(app, 'LEADER_P2', url(q))));
    expect(implicit!.selection.variant).toBe('WITHOUT_REPRICING');
    expect(implicit!.rows).toEqual(without!.rows);
    expect(withRepricing!.selection.variant).toBe('WITH_REPRICING');
    expect(withRepricing!.rows[0]!.values).not.toEqual(without!.rows[0]!.values);
    const cases = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url('metricCode=CASE_COUNT'));
    expect(cases.selection).toEqual({ metricCode: 'CASE_COUNT', comparison: 'CURRENT_YEAR' });
    expect(cases.rows[0]!.values[0]).toMatchObject({ kind: 'COUNT' });
  });

  it('AC-P4-03-19 AC-P4-03-20 AC-P4-03-31 table: closed months and the partial 2026-07 have values, later months are "-"; month-over-month, January vs the previous December', async () => {
    const vm = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url());
    expect(vm.rows.slice(0, 7).every((r) => r.values[0] !== null)).toBe(true);
    expect(vm.rows.slice(7).every((r) => r.values[0] === null && r.changes[0] === null)).toBe(true);
    // Recompute each change from the returned values: Jan uses Dec 2025 (read from the 2025 column of VS_LAST_YEAR).
    const last = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url('comparison=VS_LAST_YEAR'));
    const dec2025 = last.rows[11]!.values[1]!;
    expect(vm.rows[0]!.changes[0]?.comparisonBasis).toBe('LAST_MONTH');
    expect(vm.rows[0]!.changes[0]?.pct).toBe(pctChangeOneDecimal(vm.rows[0]!.values[0]!, dec2025));
    for (let m = 1; m < 7; m++) expect(vm.rows[m]!.changes[0]?.pct).toBe(pctChangeOneDecimal(vm.rows[m]!.values[0]!, vm.rows[m - 1]!.values[0]!));
  });

  it('AC-P4-03-20 AC-P4-03-21 AC-P4-03-22 over HTTP, both scopes: CURRENT_YEAR uses [LAST_MONTH]; VS_LAST_YEAR and VS_LAST_2_YEARS never use LAST_MONTH', async () => {
    for (const scope of ['TEAM', 'SELF'] as const) {
      const persona: PersonaKey = scope === 'TEAM' ? 'LEADER_P2' : 'AGENT_P4';
      const metrics = scope === 'TEAM' ? CONFIG.screens.historicalData.metrics : CONFIG.screens.historicalData.self!.metrics;
      for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS']) {
        for (const m of metrics) {
          const r = await app.inject({ method: 'GET', url: url(`scope=${scope}&metricCode=${m.metricCode}${m.variant ? `&variant=${m.variant}` : ''}&comparison=${comparison}`), headers: personaHeaders(persona) });
          expect(r.statusCode).toBe(200);
          const vm = r.json() as HistoricalDataVM;
          const label = `${scope} ${comparison} ${m.metricCode}`;
          expect(vm.changeColumns.map((c) => c.basis), label).toEqual(comparison === 'CURRENT_YEAR' ? ['LAST_MONTH'] : comparison === 'VS_LAST_YEAR' ? ['LAST_YEAR'] : ['LAST_YEAR', 'LAST_2_YEARS']);
          if (comparison === 'CURRENT_YEAR') expect(vm.totals?.changes ?? [null], label).toEqual([null]);
          else expect(r.body, label).not.toContain('LAST_MONTH');
        }
      }
    }
  });

  it('AC-P4-03-21 AC-P4-03-22 the comparison selects 1, 2 or 3 year columns and 1, 1 or 2 change columns', async () => {
    const shapes = await Promise.all(['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS'].map(async (c) => {
      const vm = await getJson<HistoricalDataVM>(app, 'LEADER_P2', url(`comparison=${c}`));
      return [vm.years, vm.changeColumns.map((x) => x.basis), vm.rows[2]!.values.length, vm.rows[2]!.changes.length];
    }));
    expect(shapes).toEqual([
      [[2026], ['LAST_MONTH'], 1, 1], [[2026, 2025], ['LAST_YEAR'], 2, 1], [[2026, 2025, 2024], ['LAST_YEAR', 'LAST_2_YEARS'], 3, 2],
    ]);
  });

  it('AC-P4-03-30 TAKAFUL reads the PBTB database (stub: one fifth of PAMB); INSURANCE and ALL read PAMB; teamView GROUP reads the Group aggregation', async () => {
    const amount = async (query: string) => {
      const v = (await getJson<HistoricalDataVM>(app, 'LEADER_P2', url(query))).rows[0]!.values[0];
      return v?.kind === 'MONEY' ? v.amount : undefined;
    };
    const [all, insurance, takaful, group] = await Promise.all([amount(''), amount('businessLine=INSURANCE'), amount('businessLine=TAKAFUL'), amount('teamView=GROUP')]);
    expect(all).toBe('102000.00');
    expect(insurance).toBe(all);
    expect(takaful).toBe('20400.00');
    expect(group).toBe('224400.00'); // Group = 33/5 of Personal; DirectUnit = 3x
  });

  describe('AC-P4-03-29 gating', () => {
    it('a non-leader gets 403 BFF-4032', async () => {
      for (const persona of ['AGENT_P4', 'AGENT_EMPTY', 'AGENT_PROCESSING'] as const) expect(await problem(persona)).toEqual({ status: 403, code: 'BFF-4032' });
    });
    it('GROUP needs a P2 leader: P3 gets 403 BFF-4031, P2 gets 200; P3 DIRECT is allowed', async () => {
      expect(await problem('LEADER_P3', 'teamView=GROUP')).toEqual({ status: 403, code: 'BFF-4031' });
      expect(await status('LEADER_P2', 'teamView=GROUP')).toBe(200);
      expect(await status('LEADER_P3')).toBe(200);
      expect(await status('LEADER_P3', 'teamView=DIRECT')).toBe(200);
    });
    it('authorization is decided before the selection is validated', async () => {
      expect(await problem('AGENT_P4', 'metricCode=NOPE')).toEqual({ status: 403, code: 'BFF-4032' });
    });
  });

  describe('BFF-4000 for an invalid query', () => {
    const bad: Array<[string, string]> = [
      ['scope=self', 'scope is case sensitive'],
      ['scope=TEAM&scope=SELF', 'a repeated scope'],
      ['scope=', 'empty scope'],
      ['scope=REGION', 'unknown scope'],
      ['metricCode=NOPE', 'unknown metricCode'],
      ['metricCode=PTPC', 'a catalog metric that is not on this screen'],
      ['metricCode=PERSISTENCY_CY', 'persistency'],
      ['metricCode=tpc', 'metricCode is case sensitive'],
      ['metricCode=CASE_COUNT&variant=WITHOUT_REPRICING', 'a variant on a metric without variants'],
      ['metricCode=MANPOWER&variant=WITH_REPRICING', 'a variant on a MAPA metric'],
      ['variant=SOMETHING', 'unknown TPC variant'],
      ['variant=', 'empty variant'],
      ['comparison=VS_LAST_3_YEARS', 'unknown comparison'],
      ['comparison=current_year', 'comparison is case sensitive'],
      ['basis=SCHEME', 'basis other than STANDARD'],
      ['businessLine=WHOLESALE', 'unknown businessLine'],
      ['teamView=REGION', 'unknown teamView'],
      ['metricCode=TPC&metricCode=CASE_COUNT', 'a repeated parameter'],
      ['comparison=VS_LAST_YEAR&comparison=CURRENT_YEAR', 'a repeated comparison'],
    ];
    for (const [query, why] of bad) {
      it(`AC-P4-03-29 ${why} → 400`, async () => {
        expect(await problem('LEADER_P2', query)).toEqual({ status: 400, code: 'BFF-4000' });
      });
    }
    it('AC-P4-03-29 the explicit scope=TEAM, explicit defaults and TPC with either variant are accepted', async () => {
      for (const query of ['scope=TEAM', 'metricCode=TPC&variant=WITHOUT_REPRICING', 'metricCode=TPC&variant=WITH_REPRICING', 'basis=STANDARD&comparison=CURRENT_YEAR&teamView=DIRECT&businessLine=ALL']) {
        expect(await status('LEADER_P2', query), query).toBe(200);
      }
    });
  });

  it('the legacy GET /performance/metrics/:code/history route still serves the SELF flow unchanged', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC/history?window=VS_LAST_2_YEARS`);
    expect(d.years).toEqual([2026, 2025, 2024]);
    expect(d.comparison.windowOptions).toEqual(['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS']);
  });
});

describe('AC-P4-03-33 / AC-P4-03-34 GET historical-data?scope=SELF over HTTP (memory source)', () => {
  const url = (query = '') => `${BFF}/performance/historical-data${query ? `?${query}` : ''}`;
  const res = (persona: PersonaKey, query = '') => app.inject({ method: 'GET', url: url(query), headers: personaHeaders(persona) });
  const problem = async (persona: PersonaKey, query = '') => { const r = await res(persona, query); return { status: r.statusCode, code: r.json().code as string | undefined }; };
  const SELF_ORDER = ['TPC/WITHOUT_REPRICING', 'TPC/WITH_REPRICING', 'CASE_COUNT', 'FYP', 'FYC'];
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterAll(() => { vi.useRealTimers(); });

  it('AC-P4-03-33 every persona gets 200 for its own data: no leader requirement for scope=SELF', async () => {
    for (const persona of ['AGENT_P4', 'LEADER_P3', 'LEADER_P2'] as const) {
      const vm = await getJson<HistoricalDataVM>(app, persona, url('scope=SELF'));
      expect(vm.dataState, persona).toBe('OK');
      expect(vm.context.scope).toBe('SELF');
    }
    // The demo agents without rows get the empty frame, not an error.
    for (const persona of ['AGENT_EMPTY', 'AGENT_PROCESSING'] as const) {
      const vm = await getJson<HistoricalDataVM>(app, persona, url('scope=SELF'));
      expect([vm.dataState, vm.rows.length, vm.totals?.values]).toEqual(['EMPTY', 12, [null]]);
    }
  });

  it('AC-P4-03-33 context.scope is SELF and there is no teamView key (a teamView query is ignored, even GROUP for a P4)', async () => {
    for (const [persona, query] of [['AGENT_P4', 'scope=SELF'], ['AGENT_P4', 'scope=SELF&teamView=GROUP'], ['LEADER_P3', 'scope=SELF&teamView=GROUP'], ['LEADER_P2', 'scope=SELF&teamView=DIRECT']] as const) {
      const vm = await getJson<HistoricalDataVM>(app, persona, url(query));
      expect(vm.context, `${persona} ${query}`).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
      expect('teamView' in vm.context).toBe(false);
    }
    // teamView is not even validated for SELF.
    expect((await res('AGENT_P4', 'scope=SELF&teamView=REGION')).statusCode).toBe(200);
  });

  it('AC-P4-03-33 the metric list is exactly the five self metrics in order; the default is TPC without repricing', async () => {
    const vm = await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF'));
    expect(vm.filter.metrics.map((m) => `${m.metricCode}${m.variant ? `/${m.variant}` : ''}`)).toEqual(SELF_ORDER);
    expect(vm.selection).toEqual({ metricCode: 'TPC', variant: 'WITHOUT_REPRICING', comparison: 'CURRENT_YEAR' });
    expect(vm.filter.metrics.filter((m) => m.selected)).toHaveLength(1);
    expect(vm.filter.comparisons.map((c) => c.comparison)).toEqual(['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS']);
  });

  it('AC-P4-03-33 FYP and FYC work for all three comparisons, with totals (Personal stub values)', async () => {
    for (const metricCode of ['FYP', 'FYC']) {
      for (const comparison of ['CURRENT_YEAR', 'VS_LAST_YEAR', 'VS_LAST_2_YEARS']) {
        const vm = await getJson<HistoricalDataVM>(app, 'AGENT_P4', url(`scope=SELF&metricCode=${metricCode}&comparison=${comparison}`));
        expect([vm.dataState, vm.valueType, vm.selection.metricCode, vm.anchorYear], `${metricCode} ${comparison}`).toEqual(['OK', 'MONEY', metricCode, 2026]);
        expect(vm.rows.slice(0, 7).every((r) => r.values[0]?.kind === 'MONEY')).toBe(true);
        expect(vm.totals!.values[0]).toMatchObject({ kind: 'MONEY', currency: 'MYR' });
        expect(vm.totals!.changes).toHaveLength(vm.changeColumns.length);
        // CURRENT_YEAR: the Total row's LAST_MONTH cell is empty (null); the year-over-year cells are not.
        expect(vm.totals!.changes.every((c) => comparison === 'CURRENT_YEAR' ? c === null : c !== null && c.comparisonBasis !== 'LAST_MONTH')).toBe(true);
        expect(vm.changeColumns.map((c) => c.basis)).toEqual(comparison === 'CURRENT_YEAR' ? ['LAST_MONTH'] : comparison === 'VS_LAST_YEAR' ? ['LAST_YEAR'] : ['LAST_YEAR', 'LAST_2_YEARS']);
      }
    }
  });

  it('AC-P4-03-33 SELF is the Personal aggregation: a third of the DirectUnit figure in the stub; TAKAFUL reads PBTB', async () => {
    const jan = async (query: string) => { const v = (await getJson<HistoricalDataVM>(app, 'LEADER_P2', url(query))).rows[0]!.values[0]; return v?.kind === 'MONEY' ? v.amount : undefined; };
    expect(await jan('scope=SELF')).toBe('34000.00');
    expect(await jan('scope=TEAM')).toBe('102000.00'); // DirectUnit = 3x Personal, TEAM unchanged
    expect(await jan('scope=SELF&businessLine=TAKAFUL')).toBe('6800.00'); // PBTB = 1/5 of PAMB
  });

  it('AC-P4-03-33 the Personal stub carries production values for TPC (both variants), FYP, FYC and CASE_COUNT', async () => {
    const r = await app.inject({ method: 'GET', url: '/insights/v1/agents/L3001/monthly-history?from=2026-01&to=2026-03&aggregation=Personal', headers: { 'x-agent-id': 'L3001' } });
    const pamb = (r.json() as MonthlyHistory).records.filter((x) => x.source === 'PAMB');
    expect(pamb).toHaveLength(3);
    for (const rec_ of pamb) {
      const values = Object.fromEntries(rec_.production!.metrics.map((m) => [`${m.metricCode}${m.variant ? `/${m.variant}` : ''}`, m.value]));
      for (const key of ['TPC/WITHOUT_REPRICING', 'TPC/WITH_REPRICING', 'FYP', 'FYC', 'CASE_COUNT']) expect(values[key], key).not.toBeNull();
    }
  });

  it('AC-P4-03-33 a metric that is only on the TEAM list is 400 BFF-4000 for SELF (and FYP/FYC stay SELF-only)', async () => {
    for (const metricCode of ['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE', 'NEW_RECRUIT_CONTRACTED', 'PTPC', 'NOPE']) {
      expect(await problem('AGENT_P4', `scope=SELF&metricCode=${metricCode}`), metricCode).toEqual({ status: 400, code: 'BFF-4000' });
    }
    for (const metricCode of ['FYP', 'FYC']) expect(await problem('LEADER_P2', `scope=TEAM&metricCode=${metricCode}`), metricCode).toEqual({ status: 400, code: 'BFF-4000' });
    expect((await res('LEADER_P2', 'metricCode=FYP')).statusCode).toBe(400); // absent scope = TEAM
  });

  it('AC-P4-03-33 only TPC takes a variant (defaults to WITHOUT_REPRICING); a variant on any other self metric is 400', async () => {
    for (const metricCode of ['CASE_COUNT', 'FYP', 'FYC']) {
      expect(await problem('AGENT_P4', `scope=SELF&metricCode=${metricCode}&variant=WITH_REPRICING`), metricCode).toEqual({ status: 400, code: 'BFF-4000' });
      expect(await problem('AGENT_P4', `scope=SELF&metricCode=${metricCode}&variant=WITHOUT_REPRICING`), metricCode).toEqual({ status: 400, code: 'BFF-4000' });
    }
    expect(await problem('AGENT_P4', 'scope=SELF&variant=BOGUS')).toEqual({ status: 400, code: 'BFF-4000' });
    expect((await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF&metricCode=TPC&variant=WITH_REPRICING'))).selection.variant).toBe('WITH_REPRICING');
    expect((await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF&metricCode=TPC'))).selection.variant).toBe('WITHOUT_REPRICING');
  });

  it('AC-P4-03-33 SELF obeys the same lens validation: bad businessLine / basis are 400', async () => {
    expect(await problem('AGENT_P4', 'scope=SELF&businessLine=WHOLESALE')).toEqual({ status: 400, code: 'BFF-4000' });
    expect(await problem('AGENT_P4', 'scope=SELF&basis=SCHEME')).toEqual({ status: 400, code: 'BFF-4000' });
    expect(await problem('AGENT_P4', 'scope=SELF&comparison=VS_LAST_3_YEARS')).toEqual({ status: 400, code: 'BFF-4000' });
    expect((await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF&businessLine=TAKAFUL'))).context.businessLine).toBe('TAKAFUL');
  });

  describe('AC-P4-03-34 gating is unchanged for TEAM', () => {
    it('an agent persona with scope=TEAM (explicit or absent) is still 403 BFF-4032', async () => {
      for (const persona of ['AGENT_P4', 'AGENT_EMPTY', 'AGENT_PROCESSING'] as const) {
        expect(await problem(persona, 'scope=TEAM'), persona).toEqual({ status: 403, code: 'BFF-4032' });
        expect(await problem(persona), persona).toEqual({ status: 403, code: 'BFF-4032' });
      }
    });
    it('GROUP without P2 is still 403 BFF-4031 for TEAM, and a P3 gets 200 for DIRECT', async () => {
      expect(await problem('LEADER_P3', 'scope=TEAM&teamView=GROUP')).toEqual({ status: 403, code: 'BFF-4031' });
      expect(await problem('LEADER_P3', 'teamView=GROUP')).toEqual({ status: 403, code: 'BFF-4031' });
      expect((await res('LEADER_P2', 'scope=TEAM&teamView=GROUP')).statusCode).toBe(200);
      expect((await res('LEADER_P3', 'scope=TEAM')).statusCode).toBe(200);
    });
    it('an absent scope means TEAM: identical payload to scope=TEAM (context, selection, filter, rows, totals)', async () => {
      const [absent, team] = await Promise.all(['', 'scope=TEAM'].map((q) => getJson<HistoricalDataVM>(app, 'LEADER_P2', url(q))));
      expect(absent!.context).toEqual({ businessLine: 'ALL', basis: 'STANDARD', scope: 'TEAM', teamView: 'DIRECT' });
      const strip = ({ meta: _meta, ...rest }: HistoricalDataVM) => rest;
      expect(strip(absent!)).toEqual(strip(team!));
      expect(absent!.filter.metrics).toHaveLength(8);
    });
    it('an unknown scope is 400 for everyone', async () => {
      for (const persona of ['AGENT_P4', 'LEADER_P2'] as const) {
        for (const q of ['scope=REGION', 'scope=self', 'scope=']) expect(await problem(persona, q), `${persona} ${q}`).toEqual({ status: 400, code: 'BFF-4000' });
      }
    });
    it('SELF never grants team data: a P4 asking SELF with teamView=GROUP gets its own Personal rows, not Group', async () => {
      const own = await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF&teamView=GROUP'));
      const plain = await getJson<HistoricalDataVM>(app, 'AGENT_P4', url('scope=SELF'));
      const strip = ({ meta: _meta, ...rest }: HistoricalDataVM) => rest;
      expect(strip(own)).toEqual(strip(plain));
    });
  });
});
