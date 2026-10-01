import { afterEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { buildApp } from '../src/app.js';
import { PerformanceSource } from '../src/data/performance-source.js';
import { PERFORMANCE_READ_TIMEOUT_MS } from '../src/config/performance.js';
import { compareMonthlyCandidates, monthlyCandidate, selectMonthlyRow } from '../src/data/monthly-history.js';
import type { AgentRecord } from '../src/data/registry.js';
import type { MonthlyHistoryRecord, MonthlyHistoryRequest } from '../src/types.js';
import { fakeMongo } from './support/mongo-fake.js';

process.env.MONGODB_URI = '';
const AGENT = 'MOCK_SELF';
const agent: AgentRecord = { agentId: AGENT, tenant: 'MY', level: 'P2', name: 'Mock' };
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

interface RowOptions {
  id?: string; _id?: string; year: number; month: number; aggregation?: string; entity?: string; caseStatus?: string;
  /** Declared as-on day; `Date` and string spellings are stored as the source does. Omit = undeclared. */
  day?: number | Date | string | null; flag?: string | null; asOn?: string | Date;
  values?: Record<string, number | string | null>; ytd?: number;
}
const YTD = 999_999; // sentinel: anything reading a YTD leaf instead of MTD shows up as 999999
const mtd = (o: RowOptions, key: string, fallback: number) => (o.values && key in o.values ? o.values[key] : fallback);
const base = (o: RowOptions): Document => ({
  ...(o.id !== undefined ? { id: o.id } : {}),
  ...(o._id !== undefined ? { _id: o._id } : {}),
  agentId: AGENT, agentName: 'SECRET NAME', agentAggregation: o.aggregation ?? 'DirectUnit', entity: o.entity ?? 'PAMB', agentType: 'PAMB', agentStatus: 'Active',
  period: { year: o.year, month: o.month, quarter: `Q${Math.ceil(o.month / 3)}`, yyyymm: `${o.year}${pad(o.month)}`, ...(o.day !== undefined ? { asOnMonthDay: o.day } : {}) },
  asOnDate: o.asOn ?? `${o.year}-${pad(o.month)}-${pad(Math.min(28, lastDay(o.year, o.month)))}T00:00:00Z`,
  isMonthEnd: o.flag ?? null,
});
/** my_production export shape: MTD/QTD/YTD leaves, `caseStatus`, asOnMonthDay stored as a UTC date. */
const production = (o: RowOptions): Document => ({
  ...base(o), caseStatus: o.caseStatus ?? 'Collected',
  ptd: {
    tpc: { withoutRepricing: { mtd: mtd(o, 'tpc', 100), qtd: 1, ytd: YTD }, withRepricing: { mtd: mtd(o, 'tpcRe', 120), qtd: 1, ytd: YTD } },
    ptpc: { withoutRepricing: { mtd: mtd(o, 'ptpc', 50), ytd: YTD }, withRepricing: { mtd: mtd(o, 'ptpcRe', 60), ytd: YTD } },
    fyp: { mtd: mtd(o, 'fyp', 400), ytd: YTD }, fyc: { mtd: mtd(o, 'fyc', 200), ytd: YTD }, caseCount: { total: { mtd: mtd(o, 'cases', 3), ytd: YTD } },
  },
});
/** my_mapa export shape: yyyymm spelled "2025-01" and asOnDate a real Date (both differ from production). */
const mapa = (o: RowOptions): Document => {
  const row = base(o);
  return {
    ...row, period: { ...row.period, yyyymm: `${o.year}-${pad(o.month)}` }, asOnDate: o.asOn ?? new Date(`${o.year}-${pad(o.month)}-28T00:00:00Z`),
    ptd: {
      manpowerTotal: { mtd: mtd(o, 'manpower', 10), ytd: YTD }, activityRatio: { mtd: mtd(o, 'activity', 80.5), ytd: YTD },
      productivity: { mtd: mtd(o, 'productivity', 2.5), ytd: YTD }, averageCaseSize: { mtd: mtd(o, 'acs', 1234.5), ytd: YTD },
      newRecruits: { mtd: mtd(o, 'recruits', 2), ytd: YTD },
    },
  };
};

const REQUEST: MonthlyHistoryRequest = { from: '2024-01', to: '2025-12' };
const read = async (data: { PAMB?: Record<string, Document[]>; PBTB?: Record<string, Document[]> }, req: MonthlyHistoryRequest = REQUEST, logs: string[] = []) => {
  const m = fakeMongo(data.PAMB, data.PBTB);
  const source = new PerformanceSource(m.dbs, new Map(), (line) => logs.push(line));
  return { ...m, history: await source.monthlyHistory(agent, req), logs };
};
const one = async (rows: Document[], collection: 'my_production' | 'my_mapa' = 'my_production'): Promise<MonthlyHistoryRecord> => {
  const { history } = await read({ PAMB: { [collection]: rows } });
  expect(history.records).toHaveLength(1);
  return history.records[0]!;
};
const tpc = (record: MonthlyHistoryRecord) => {
  const value = record.production?.metrics[0]?.value;
  return value?.kind === 'MONEY' ? value.amount : undefined;
};

describe('PerformanceSource.monthlyHistory (ARVIJ-1450, AC-P4-03-28)', () => {
  it('AC-P4-03-28 reads both databases and both collections with a whitelist projection, bounded time and exact filters', async () => {
    const { pamb, pbtb } = await read({}, { from: '2024-03', to: '2025-02' });
    for (const [entity, requests] of [['PAMB', pamb.requests], ['PBTB', pbtb.requests]] as const) {
      expect(requests.map((r) => r.collection).sort()).toEqual(['my_mapa', 'my_production']);
      for (const request of requests) {
        // `entity` is the database's own literal; the year range is coarse (months are filtered in code).
        expect(request.query).toEqual({
          agentId: AGENT, entity, 'period.year': { $gte: 2024, $lte: 2025 },
          ...(request.collection === 'my_production' ? { caseStatus: 'Collected' } : {}),
        });
        expect(request.options.projection).toEqual({ _id: 0, id: 1, period: 1, asOnDate: 1, isMonthEnd: 1, agentAggregation: 1, ptd: 1 });
        expect(request.options.maxTimeMS).toBe(PERFORMANCE_READ_TIMEOUT_MS);
      }
    }
  });

  it('AC-P4-03-28 never reads persistency or hierarchy, and no names/IDs/vault data leave Mongo', async () => {
    const { pamb, pbtb, history } = await read({ PAMB: { my_production: [production({ year: 2024, month: 5 })], my_mapa: [mapa({ year: 2024, month: 5 })] } });
    expect([...pamb.requests, ...pbtb.requests].every((r) => ['my_production', 'my_mapa'].includes(r.collection))).toBe(true);
    const text = JSON.stringify(history.records);
    expect(history.records).toHaveLength(1);
    for (const leaked of ['SECRET NAME', 'agentName', AGENT, 'agentId', '"id"', '_id', 'entity', 'agentType', 'agentStatus', 'caseStatus']) expect(text, leaked).not.toContain(leaked);
    expect(history.agentId).toBe(AGENT);
  });

  it('AC-P4-03-28 passes the aggregation through and has no aggregation fallback', async () => {
    const personalOnly = { my_production: [production({ year: 2024, month: 5, aggregation: 'Personal' })], my_mapa: [mapa({ year: 2024, month: 5, aggregation: 'Personal' })] };
    const { history, pamb } = await read({ PAMB: personalOnly }, { ...REQUEST, aggregation: 'Group' });
    expect(history.records).toEqual([]);
    expect(pamb.requests).toHaveLength(2); // no second "any aggregation" read
    expect(pamb.requests.every((r) => r.query.agentAggregation === 'Group')).toBe(true);
    expect((await read({ PAMB: personalOnly }, { ...REQUEST, aggregation: 'Personal' })).history.records).toHaveLength(1);
    // Without an aggregation filter every aggregation is returned and no filter is sent.
    const all = await read({ PAMB: { my_production: [production({ year: 2024, month: 5, aggregation: 'Personal' }), production({ year: 2024, month: 5, aggregation: 'Group' })] } });
    expect(all.history.records.map((r) => r.aggregation)).toEqual(['Personal', 'Group']);
    expect(all.pamb.requests.every((r) => !('agentAggregation' in r.query))).toBe(true);
  });

  describe('one row per (collection, source, month, aggregation): D2 selection', () => {
    const pick = async (rows: Document[]) => tpc(await one(rows));

    it('AC-P4-03-28 prefers the row flagged month-end over a later declared day and a later asOnDate', async () => {
      expect(await pick([
        production({ id: 'a', year: 2025, month: 3, day: 30, asOn: '2025-04-05T00:00:00Z', values: { tpc: 1 } }),
        production({ id: 'b', year: 2025, month: 3, day: 15, flag: 'Y', asOn: '2025-03-15T00:00:00Z', values: { tpc: 2 } }),
        production({ id: 'c', year: 2025, month: 3, day: 31, values: { tpc: 3 } }),
      ])).toBe('2.00');
    });

    it('AC-P4-03-28 without a flag takes the greatest declared as-on day, whatever its type (Int, Date or string)', async () => {
      const day = (n: number, how: 'int' | 'date' | 'string') => how === 'int' ? n : how === 'date' ? new Date(Date.UTC(2025, 2, n)) : String(n);
      expect(await pick([
        production({ id: 'a', year: 2025, month: 3, day: day(15, 'int'), asOn: '2025-04-30T00:00:00Z', values: { tpc: 1 } }),
        production({ id: 'b', year: 2025, month: 3, day: day(20, 'date'), values: { tpc: 2 } }),
        production({ id: 'c', year: 2025, month: 3, day: day(25, 'string'), asOn: '2025-03-01T00:00:00Z', values: { tpc: 3 } }),
        production({ id: 'd', year: 2025, month: 3, day: day(24, 'int'), values: { tpc: 4 } }),
      ])).toBe('3.00');
      // Same on my_mapa, where the day is a bare Int/string rather than a date.
      const m = await one([
        mapa({ id: 'a', year: 2025, month: 3, day: 9, values: { manpower: 1 } }), mapa({ id: 'b', year: 2025, month: 3, day: '27', values: { manpower: 2 } }),
      ], 'my_mapa');
      expect(m.mapa?.metrics[0]?.value).toEqual({ kind: 'COUNT', value: 2 });
    });

    it('AC-P4-03-28 a row that declares an as-on day outranks one that declares none, even with a later asOnDate', async () => {
      expect(await pick([
        production({ id: 'a', year: 2025, month: 3, asOn: '2025-09-01T00:00:00Z', values: { tpc: 1 } }),
        production({ id: 'b', year: 2025, month: 3, day: 2, asOn: '2025-03-02T00:00:00Z', values: { tpc: 2 } }),
      ])).toBe('2.00');
    });

    it('AC-P4-03-28 with no flag and no declared day the greatest asOnDate wins, time of day included', async () => {
      expect(await pick([
        production({ id: 'a', year: 2025, month: 3, asOn: '2025-03-10T08:00:00Z', values: { tpc: 1 } }),
        production({ id: 'b', year: 2025, month: 3, asOn: '2025-03-10T17:30:00Z', values: { tpc: 2 } }),
        production({ id: 'c', year: 2025, month: 3, asOn: '2025-03-09T23:59:59Z', values: { tpc: 3 } }),
      ])).toBe('2.00');
    });

    it('AC-P4-03-28 final ties go to the greatest id, then the greatest _id', async () => {
      const same = { year: 2025, month: 3, day: 28, asOn: '2025-03-28T00:00:00Z' } as const;
      expect(await pick([production({ ...same, id: 'x-1', values: { tpc: 1 } }), production({ ...same, id: 'x-3', values: { tpc: 3 } }), production({ ...same, id: 'x-2', values: { tpc: 2 } })])).toBe('3.00');
      expect(await pick([production({ ...same, id: 'x', _id: 'a', values: { tpc: 1 } }), production({ ...same, id: 'x', _id: 'c', values: { tpc: 3 } }), production({ ...same, id: 'x', _id: 'b', values: { tpc: 2 } })])).toBe('3.00');
    });

    it('AC-P4-03-28 selection is independent of read order and chosen per month and aggregation', async () => {
      const rows = [
        production({ id: 'a', year: 2025, month: 1, flag: 'Y', values: { tpc: 11 } }), production({ id: 'b', year: 2025, month: 1, day: 31, values: { tpc: 12 } }),
        production({ id: 'c', year: 2025, month: 2, day: 10, values: { tpc: 21 } }), production({ id: 'd', year: 2025, month: 2, day: 20, values: { tpc: 22 } }),
        production({ id: 'e', year: 2025, month: 2, aggregation: 'Group', day: 5, values: { tpc: 31 } }),
      ];
      const forward = (await read({ PAMB: { my_production: rows } })).history.records.map((r) => [r.period, r.aggregation, tpc(r)]);
      const reversed = (await read({ PAMB: { my_production: [...rows].reverse() } })).history.records.map((r) => [r.period, r.aggregation, tpc(r)]);
      expect(forward).toEqual([['2025-01', 'DirectUnit', '11.00'], ['2025-02', 'DirectUnit', '22.00'], ['2025-02', 'Group', '31.00']]);
      expect(reversed).toEqual(forward);
    });

    it('AC-P4-03-28 the comparator ranks flag, then declared day, then asOnDate, then id', () => {
      const c = (o: RowOptions) => monthlyCandidate(production(o));
      const mk = { year: 2025, month: 3 } as const;
      expect(compareMonthlyCandidates(c({ ...mk, flag: 'Y', day: 1 }), c({ ...mk, day: 31 }))).toBeLessThan(0);
      expect(compareMonthlyCandidates(c({ ...mk, day: 20 }), c({ ...mk, day: 19, asOn: '2026-01-01T00:00:00Z' }))).toBeLessThan(0);
      expect(compareMonthlyCandidates(c({ ...mk, day: 20, id: 'a' }), c({ ...mk, day: 20, id: 'b' }))).toBeGreaterThan(0);
      expect(compareMonthlyCandidates(c({ ...mk, day: 20, id: 'a' }), c({ ...mk, day: 20, id: 'a' }))).toBe(0);
      expect(selectMonthlyRow([])).toBeUndefined();
    });
  });

  describe('records', () => {
    it('AC-P4-03-28 are ascending by period, then source (PAMB, PBTB), then aggregation; months without rows are omitted', async () => {
      const { history } = await read({
        PAMB: {
          my_production: [
            production({ year: 2025, month: 2, aggregation: 'Group' }), production({ year: 2024, month: 12, aggregation: 'Personal' }),
            production({ year: 2025, month: 2, aggregation: 'Personal' }), production({ year: 2024, month: 11, aggregation: 'DirectUnit' }),
          ],
          my_mapa: [mapa({ year: 2025, month: 2, aggregation: 'DirectUnit' })],
        },
        PBTB: { my_production: [production({ year: 2025, month: 2, aggregation: 'Personal', entity: 'PBTB' }), production({ year: 2024, month: 11, aggregation: 'Group', entity: 'PBTB' })] },
      });
      expect(history.records.map((r) => `${r.period} ${r.source} ${r.aggregation}`)).toEqual([
        '2024-11 PAMB DirectUnit', '2024-11 PBTB Group', '2024-12 PAMB Personal',
        '2025-02 PAMB Personal', '2025-02 PAMB DirectUnit', '2025-02 PAMB Group', '2025-02 PBTB Personal',
      ]);
      expect(history.records.some((r) => r.period === '2025-01')).toBe(false);
    });

    it('AC-P4-03-28 merge both collections; a collection without a row leaves its part null (PBTB has no my_mapa)', async () => {
      const { history } = await read({
        PAMB: { my_production: [production({ year: 2025, month: 4 })], my_mapa: [mapa({ year: 2025, month: 4 }), mapa({ year: 2025, month: 5 })] },
        PBTB: { my_production: [production({ year: 2025, month: 4, entity: 'PBTB' })] },
      });
      const by = (source: string, period: string) => history.records.find((r) => r.source === source && r.period === period)!;
      expect([by('PAMB', '2025-04').production !== null, by('PAMB', '2025-04').mapa !== null]).toEqual([true, true]);
      expect([by('PAMB', '2025-05').production, by('PAMB', '2025-05').mapa !== null]).toEqual([null, true]);
      expect([by('PBTB', '2025-04').production !== null, by('PBTB', '2025-04').mapa]).toEqual([true, null]);
    });

    it('AC-P4-03-28 a database is read by its own entity: PBTB rows never appear as PAMB', async () => {
      const { history } = await read({ PAMB: { my_production: [production({ year: 2025, month: 4, values: { tpc: 1 } })] }, PBTB: { my_production: [production({ year: 2025, month: 4, entity: 'PBTB', values: { tpc: 2 } })] } });
      expect(history.records.map((r) => [r.source, tpc(r)])).toEqual([['PAMB', '1.00'], ['PBTB', '2.00']]);
      // A row whose entity does not match the database is not read at all.
      const mismatch = await read({ PAMB: { my_production: [production({ year: 2025, month: 4, entity: 'PBTB' })] } });
      expect(mismatch.history.records).toEqual([]);
    });

    it('AC-P4-03-28 production skips rows that are not Collected', async () => {
      const { history } = await read({ PAMB: { my_production: [production({ year: 2025, month: 4, caseStatus: 'Pending', values: { tpc: 7 } })] } });
      expect(history.records).toEqual([]);
    });

    it('AC-P4-03-28 filters months in code (period.yyyymm spelling is never used) and drops months outside the range', async () => {
      const { history } = await read({
        PAMB: {
          my_production: [production({ year: 2025, month: 1 }), production({ year: 2025, month: 3 }), production({ year: 2025, month: 4 }), production({ year: 2025, month: 8 }), production({ year: 2023, month: 12 }), production({ year: 2026, month: 1 })],
          my_mapa: [mapa({ year: 2025, month: 3 }), mapa({ year: 2025, month: 5 })],
        },
      }, { from: '2025-03', to: '2025-04' });
      expect(history.records.map((r) => r.period)).toEqual(['2025-03', '2025-04']);
      expect(history.records[0]!.mapa).not.toBeNull();
      expect([history.from, history.to]).toEqual(['2025-03', '2025-04']);
    });
  });

  describe('values', () => {
    it('AC-P4-03-28 takes the MTD leaf of every contract metric (never YTD) in the documented order', async () => {
      const record = await one([production({ year: 2025, month: 3 })]);
      expect(record.production!.metrics).toEqual([
        { metricCode: 'TPC', variant: 'WITHOUT_REPRICING', value: { kind: 'MONEY', amount: '100.00', currency: 'MYR' } },
        { metricCode: 'TPC', variant: 'WITH_REPRICING', value: { kind: 'MONEY', amount: '120.00', currency: 'MYR' } },
        { metricCode: 'PTPC', variant: 'WITHOUT_REPRICING', value: { kind: 'MONEY', amount: '50.00', currency: 'MYR' } },
        { metricCode: 'PTPC', variant: 'WITH_REPRICING', value: { kind: 'MONEY', amount: '60.00', currency: 'MYR' } },
        { metricCode: 'FYP', value: { kind: 'MONEY', amount: '400.00', currency: 'MYR' } },
        { metricCode: 'FYC', value: { kind: 'MONEY', amount: '200.00', currency: 'MYR' } },
        { metricCode: 'CASE_COUNT', value: { kind: 'COUNT', value: 3 } },
      ]);
      const m = await one([mapa({ year: 2025, month: 3 })], 'my_mapa');
      expect(m.mapa!.metrics).toEqual([
        { metricCode: 'MANPOWER', value: { kind: 'COUNT', value: 10 } },
        { metricCode: 'ACTIVITY_RATIO', value: { kind: 'PERCENT', value: 80.5 } },
        { metricCode: 'PRODUCTIVITY', value: { kind: 'DECIMAL', value: 2.5, precision: 1 } },
        { metricCode: 'AVERAGE_CASE_SIZE', value: { kind: 'MONEY', amount: '1234.50', currency: 'MYR' } },
        { metricCode: 'NEW_RECRUIT_CONTRACTED', value: { kind: 'COUNT', value: 2 } },
      ]);
      expect(JSON.stringify([record, m])).not.toContain('999999');
    });

    it('AC-P4-03-28 null, missing and invalid source values are value:null; zero stays zero; siblings survive', async () => {
      const row = production({ year: 2025, month: 3, values: { tpc: null, tpcRe: 'not-a-number', fyp: 0, fyc: null, cases: 2.5 } });
      delete (row.ptd as Document).ptpc; // a missing branch
      const record = await one([row]);
      expect(Object.fromEntries(record.production!.metrics.map((m) => [`${m.metricCode}${m.variant ? `/${m.variant}` : ''}`, m.value]))).toEqual({
        'TPC/WITHOUT_REPRICING': null, 'TPC/WITH_REPRICING': null, 'PTPC/WITHOUT_REPRICING': null, 'PTPC/WITH_REPRICING': null,
        FYP: { kind: 'MONEY', amount: '0.00', currency: 'MYR' }, FYC: null, CASE_COUNT: null, // fractional case count is not a COUNT
      });
      const noMapaValues = await one([mapa({ year: 2025, month: 3, values: { manpower: null, activity: null, productivity: null, acs: null, recruits: 0 } })], 'my_mapa');
      expect(noMapaValues.mapa!.metrics.map((m) => m.value)).toEqual([null, null, null, null, { kind: 'COUNT', value: 0 }]);
    });
  });

  describe('monthEnd and asOnDate', () => {
    it('AC-P4-03-28 isMonthEnd spellings Y/yes/true/1 are month-end; null and anything else are not (unless the day says so)', async () => {
      for (const [flag, expected] of [['Y', true], ['y', true], ['yes', true], ['TRUE', true], ['1', true], [null, false], ['N', false], ['', false], ['maybe', false]] as const) {
        const record = await one([production({ year: 2025, month: 3, day: 10, flag })]);
        expect(record.production!.monthEnd, String(flag)).toBe(expected);
      }
    });

    it('AC-P4-03-28 a declared as-on day equal to the last day of the month is month-end without a flag (leap February included)', async () => {
      const cases: Array<[number, number, number | Date | string, boolean]> = [
        [2025, 3, 31, true], [2025, 3, 30, false], [2025, 2, 28, true], [2024, 2, 28, false], [2024, 2, 29, true], [2025, 4, '30', true],
        [2025, 6, new Date(Date.UTC(2025, 5, 30)), true], [2025, 6, new Date(Date.UTC(2025, 5, 29)), false],
      ];
      for (const [year, month, day, expected] of cases) {
        expect((await one([production({ year, month, day })])).production!.monthEnd, `${year}-${month} ${String(day)}`).toBe(expected);
      }
      // No flag and no declared day: not month-end (a partial or undeclared snapshot).
      expect((await one([production({ year: 2025, month: 3 })])).production!.monthEnd).toBe(false);
    });

    it('AC-P4-03-28 asOnDate is the in-month as-on date (declared day), never the load watermark', async () => {
      const WATERMARK = '2026-09-29T00:00:00Z';
      // The dev cluster shape: a 2025-07 row declares day 12 while its watermark is 2026-09-29.
      const prod = (await one([production({ year: 2025, month: 7, day: 12, asOn: WATERMARK })])).production!;
      expect(prod).toMatchObject({ asOnDate: '2025-07-12', monthEnd: false });
      // my_mapa: a bare Int day and a Date watermark; same rule, same result.
      expect((await one([mapa({ year: 2025, month: 7, day: 12, asOn: new Date(WATERMARK) })], 'my_mapa')).mapa).toMatchObject({ asOnDate: '2025-07-12', monthEnd: false });
      // The other day spellings: UTC Date and numeric string (zero-padded in the date).
      expect((await one([production({ year: 2025, month: 7, day: new Date(Date.UTC(2025, 6, 5)), asOn: WATERMARK })])).production!.asOnDate).toBe('2025-07-05');
      expect((await one([production({ year: 2025, month: 7, day: '9', asOn: WATERMARK })])).production!.asOnDate).toBe('2025-07-09');
      // The selected row's day is used: the greatest declared day wins, and that is the date shown.
      const picked = await one([production({ id: 'a', year: 2025, month: 7, day: 12, asOn: WATERMARK }), production({ id: 'b', year: 2025, month: 7, day: 20, asOn: WATERMARK })]);
      expect(picked.production!.asOnDate).toBe('2025-07-20');
    });

    it('AC-P4-03-28 asOnDate of a row with no declared day is the last day of the month (leap February included), whatever the watermark', async () => {
      const WATERMARK = '2026-09-29T00:00:00Z';
      for (const [year, month, expected] of [[2025, 7, '2025-07-31'], [2025, 2, '2025-02-28'], [2024, 2, '2024-02-29'], [2025, 4, '2025-04-30']] as const) {
        const part = (await one([production({ year, month, asOn: WATERMARK })])).production!;
        expect(part.asOnDate, `${year}-${month}`).toBe(expected);
        // Undeclared and unflagged: not month-end (the date is only the period-end convention).
        expect(part.monthEnd).toBe(false);
      }
      // A flagged row with no declared day also reads as the month's last day, and is month-end.
      expect((await one([production({ year: 2025, month: 7, flag: 'Y', asOn: WATERMARK })])).production).toMatchObject({ asOnDate: '2025-07-31', monthEnd: true });
    });

    it('AC-P4-03-28 the watermark never leaks into the response; it only breaks ties between rows', async () => {
      const { history } = await read({ PAMB: { my_production: [
        production({ id: 'a', year: 2025, month: 7, day: 12, asOn: '2026-09-29T00:00:00Z', values: { tpc: 1 } }),
        production({ id: 'b', year: 2025, month: 7, day: 12, asOn: '2026-09-30T00:00:00Z', values: { tpc: 2 } }),
      ] } });
      expect(tpc(history.records[0]!)).toBe('2.00'); // same declared day: the later watermark wins the tie
      expect(JSON.stringify(history)).not.toMatch(/2026-09/);
      expect(history.records[0]!.production!.asOnDate).toBe('2025-07-12');
    });
  });

  it('AC-P4-03-28 period.asOnMonthDay tolerates Int, UTC Date and numeric string; a Date of another month is malformed and skipped', async () => {
    const { history } = await read({
      PAMB: {
        my_production: [
          production({ id: 'int', year: 2025, month: 1, day: 31 }),
          production({ id: 'date', year: 2025, month: 2, day: new Date(Date.UTC(2025, 1, 28)) }),
          production({ id: 'str', year: 2025, month: 3, day: '31' }),
          production({ id: 'cross', year: 2025, month: 4, day: new Date(Date.UTC(2025, 5, 30)) }),
        ],
      },
    });
    expect(history.records.map((r) => [r.period, r.production!.monthEnd])).toEqual([['2025-01', true], ['2025-02', true], ['2025-03', true]]);
  });

  it('AC-P4-03-28 malformed rows are dropped and counted, never returned or logged; the other months survive', async () => {
    const logs: string[] = [];
    const bad: Document[] = [
      { ...production({ year: 2025, month: 1 }), asOnDate: '2025-02-30T00:00:00Z' },
      { ...production({ year: 2025, month: 2 }), period: { year: '2025', month: 2 } }, // string year: not matched by the numeric range read
      { ...production({ year: 2025, month: 3 }), agentAggregation: 'Scheme' },
      { ...production({ year: 2025, month: 4 }), period: { year: 2025, month: 13 } },
      { ...production({ year: 2025, month: 5 }), asOnDate: undefined },
      { ...production({ year: 2025, month: 7 }), period: { year: 2025, month: 7, quarter: 'Q4' } },
    ];
    const { history } = await read({ PAMB: { my_production: [...bad, production({ year: 2025, month: 6 })] } }, REQUEST, logs);
    expect(history.records.map((r) => r.period)).toEqual(['2025-06']);
    expect(logs.join('\n')).toMatch(/collection=my_production .*rows=6 inRange=1 skipped=5/);
    expect(logs.join('\n')).not.toMatch(new RegExp(`${AGENT}|SECRET|2025-02-30`));
  });

  it('AC-P4-03-28 rejects an invalid identity or range before reading', async () => {
    const m = fakeMongo();
    const source = new PerformanceSource(m.dbs, new Map());
    await expect(source.monthlyHistory({ ...agent, agentId: 'a b' }, REQUEST)).rejects.toThrow('Invalid Performance identity');
    await expect(source.monthlyHistory({ ...agent, tenant: 'VN' }, REQUEST)).rejects.toThrow('Invalid Performance identity');
    await expect(source.monthlyHistory(agent, { from: '2025-02', to: '2025-01' })).rejects.toThrow('Invalid monthly history range');
    await expect(source.monthlyHistory(agent, { from: '2021-01', to: '2025-01' })).rejects.toThrow('Invalid monthly history range');
    expect(m.pamb.requests).toEqual([]);
  });

  describe('failures', () => {
    const SECRET = 'mongodb://secret-user:secret-password@private-host';
    const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${SECRET} ${name}`), { name, ...extra });
    const run = async (failures: Array<{ error: Error; collection?: string }>) => {
      const logs: string[] = [];
      const m = fakeMongo({ my_production: [production({ year: 2025, month: 3 })] }, {}, { PAMB: { failures } });
      const source = new PerformanceSource(m.dbs, new Map(), (line) => logs.push(line));
      return { logs, result: await source.monthlyHistory(agent, REQUEST).then((history) => ({ history }), (error: Error & { sourceCause?: string }) => ({ error })) };
    };

    it('AC-P4-03-28 a transient network error is retried once and then succeeds', async () => {
      const { result, logs } = await run([{ error: named('MongoNetworkError'), collection: 'my_production' }]);
      expect('history' in result && result.history.records).toHaveLength(1);
      expect(logs.some((l) => l.includes('performance read retry'))).toBe(true);
      expect(logs.join('\n')).not.toContain('secret');
    });

    it('AC-P4-03-28 a timeout is not retried: sanitized message, category only, nothing leaked', async () => {
      const { result, logs } = await run([{ error: named('MongoServerError', { code: 50 }), collection: 'my_production' }, { error: named('MongoServerError', { code: 50 }), collection: 'my_production' }]);
      const error = (result as { error: Error & { sourceCause?: string } }).error;
      expect(error.message).toBe('Monthly history source read failed');
      expect(error.sourceCause).toBe('timeout');
      expect(`${error.message} ${logs.join('\n')}`).not.toMatch(/secret|private-host|mongodb:/);
      expect(logs.some((l) => l.startsWith('performance read FAILED') && l.includes('cause=timeout'))).toBe(true);
    });

    it('AC-P4-03-28 a persistent network error fails after the one retry with cause=network', async () => {
      const { result } = await run([{ error: named('MongoNetworkError'), collection: 'my_production' }, { error: named('MongoNetworkError'), collection: 'my_production' }]);
      expect((result as { error: { sourceCause?: string } }).error.sourceCause).toBe('network');
    });
  });
});

describe('monthly-history over HTTP with the Mongo source', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
  const hierarchy = (leaderId: string, tier: string) => ({ _id: `h-${leaderId}`, asOnDate: new Date('2026-01-01'), audit: { updatedAt: new Date('2026-01-01') }, hierarchy: { leaderId }, subtree: { scopeProfileIds: [leaderId] }, displayRows: { tier } });
  const appFor = (m: ReturnType<typeof fakeMongo>) => { const app = buildApp(new PerformanceSource(m.dbs, new Map())); apps.push(app); return app; };
  const url = (id = AGENT, query = 'from=2025-01&to=2025-12') => `/insights/v1/agents/${id}/monthly-history?${query}`;

  it('AC-P4-03-28 returns the records for the caller own identity; another identity is 403 and no identity is 401', async () => {
    const app = appFor(fakeMongo({ my_agent_hierarchy: [hierarchy(AGENT, 'AM')], my_production: [production({ year: 2025, month: 3 })], my_mapa: [mapa({ year: 2025, month: 3 })] }));
    const ok = await app.inject({ url: url(), headers: { 'x-agent-id': AGENT } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().records).toHaveLength(1);
    expect(ok.body).not.toMatch(/SECRET|agentName|mongodb:/);
    const other = await app.inject({ url: url('SOMEONE_ELSE'), headers: { 'x-agent-id': AGENT } });
    expect([other.statusCode, other.json().code]).toEqual([403, 'INS-4030']);
    const anonymous = await app.inject({ url: url() });
    expect([anonymous.statusCode, anonymous.json().code]).toEqual([401, 'INS-4010']);
    expect((await app.inject({ url: url(AGENT, 'from=2025-01&to=2030-12'), headers: { 'x-agent-id': AGENT } })).statusCode).toBe(400);
  });

  it('AC-P4-03-28 an agent with no rows gets 200 with records: [] (not a 404)', async () => {
    const app = appFor(fakeMongo({ my_agent_hierarchy: [hierarchy(AGENT, 'AM')] }));
    const res = await app.inject({ url: url(), headers: { 'x-agent-id': AGENT } });
    expect([res.statusCode, res.json().records]).toEqual([200, []]);
  });

  it('AC-P4-03-28 a failed read is 503 INS-5030 with only the sanitized cause', async () => {
    const SECRET = 'mongodb://secret-user:secret-password@private-host';
    const timeout = Object.assign(new Error(`${SECRET} exceeded time limit`), { name: 'MongoServerError', code: 50 });
    const app = appFor(fakeMongo({ my_agent_hierarchy: [hierarchy(AGENT, 'AM')] }, {}, { PAMB: { failures: [{ error: timeout, collection: 'my_mapa' }] } }));
    const res = await app.inject({ url: url(), headers: { 'x-agent-id': AGENT } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INS-5030', title: 'Monthly history source unavailable (timeout)' });
    expect(res.body).not.toMatch(/secret|private-host|mongodb:/);
  });
});
