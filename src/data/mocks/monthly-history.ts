/**
 * Deterministic stub for the offline memory source (`INSIGHTS_DATA_SOURCE=memory`, tests only) behind
 * `monthlyHistory`. Integer / rational arithmetic only — no Math.random, no Date.now — so every request returns
 * the same figures. Coverage: 2023-01..2026-06 closed months (asOn = last day, month-end) plus a partial 2026-07
 * (asOn 2026-07-27); later months have no row. Both source databases and all three aggregations, both collections.
 * Never used by the Mongo source.
 */
import { mulRatio } from '../../lib/money.js';
import type { AgentRecord } from '../registry.js';
import { AS_OF_DATE } from '../values.js';
import {
  checkMonthlyRange, daysInMonth, MONTHLY_HISTORY_AGGREGATIONS, MONTHLY_HISTORY_METRICS, MONTHLY_HISTORY_SOURCES, monthPeriod,
  type MonthlyHistoryCollection,
} from '../monthly-history.js';
import type {
  MetricScalar, MonthlyHistory, MonthlyHistoryAggregation, MonthlyHistoryPart, MonthlyHistoryRecord, MonthlyHistoryRequest,
  MonthlyHistorySource, MonthlyMetricValue,
} from '../../types.js';

const FIRST_RANK = 2023 * 12 + 1;
const PARTIAL = { year: Number(AS_OF_DATE.slice(0, 4)), month: Number(AS_OF_DATE.slice(5, 7)), day: Number(AS_OF_DATE.slice(8, 10)) };
const PARTIAL_RANK = PARTIAL.year * 12 + PARTIAL.month;

type Ratio = readonly [num: number, den: number];
const SOURCE_R: Record<MonthlyHistorySource, Ratio> = { PAMB: [1, 1], PBTB: [1, 5] };
const AGGREGATION_R: Record<MonthlyHistoryAggregation, Ratio> = { Personal: [1, 1], DirectUnit: [3, 1], Group: [33, 5] };
/** Ratios (activity, productivity) do not scale with volume; each aggregation shifts them a little instead. */
const AGGREGATION_TENTHS: Record<MonthlyHistoryAggregation, number> = { Personal: 0, DirectUnit: 20, Group: -30 };

/** Percent-of-base monthly weight: a repeating wobble on a slow upward trend, always positive. */
const weight = (i: number): number => 80 + ((i * 7) % 23) * 3 + Math.floor(i / 6) * 4;

const money = (amount: string): MetricScalar => ({ kind: 'MONEY', amount, currency: 'MYR' });
/** `fraction` ⇒ part of a month (flows only); stocks and ratios pass [1, 1]. */
const scaled = (base: string, i: number, volume: Ratio, fraction: Ratio, withWeight = true): string =>
  mulRatio(mulRatio(mulRatio(base, withWeight ? weight(i) : 100, 100), volume[0], volume[1]), fraction[0], fraction[1]);
const count = (base: number, i: number, volume: Ratio, fraction: Ratio, withWeight = true): number =>
  Math.max(0, Math.round((base * (withWeight ? weight(i) : 100) * volume[0] * fraction[0]) / (100 * volume[1] * fraction[1])));

function metricValue(code: string, variant: string | undefined, i: number, source: MonthlyHistorySource, aggregation: MonthlyHistoryAggregation, fraction: Ratio): MetricScalar {
  const volume: Ratio = [SOURCE_R[source][0] * AGGREGATION_R[aggregation][0], SOURCE_R[source][1] * AGGREGATION_R[aggregation][1]];
  const repriced = (amount: string) => variant === 'WITH_REPRICING' ? mulRatio(amount, 6, 5) : amount;
  switch (code) {
    case 'TPC': return money(repriced(scaled('20000.00', i, volume, fraction)));
    case 'PTPC': return money(repriced(scaled('14000.00', i, volume, fraction)));
    case 'FYP': return money(scaled('72000.00', i, volume, fraction));
    case 'FYC': return money(scaled('36000.00', i, volume, fraction));
    case 'CASE_COUNT': return { kind: 'COUNT', value: count(6, i, volume, fraction) };
    case 'MANPOWER': return { kind: 'COUNT', value: count(25 + Math.floor(i / 3), i, volume, [1, 1], false) };
    case 'ACTIVITY_RATIO': return { kind: 'PERCENT', value: (600 + ((i * 37) % 350) + AGGREGATION_TENTHS[aggregation]) / 10 };
    case 'PRODUCTIVITY': return { kind: 'DECIMAL', value: (50 + ((i * 11) % 60)) / 10, precision: 1 };
    case 'AVERAGE_CASE_SIZE': return money(scaled('3000.00', i, [1, 1], [1, 1]));
    // 0..6 for Personal PAMB, so some months are genuinely zero (a zero prior has no % change).
    case 'NEW_RECRUIT_CONTRACTED': return { kind: 'COUNT', value: count((i * 5) % 7, i, volume, fraction, false) };
    default: throw new Error(`No stub value for ${code}`);
  }
}

function part(collection: MonthlyHistoryCollection, rank: number, source: MonthlyHistorySource, aggregation: MonthlyHistoryAggregation): MonthlyHistoryPart {
  const year = Math.floor((rank - 1) / 12), month = rank - year * 12;
  const partial = rank === PARTIAL_RANK;
  const last = daysInMonth(year, month);
  const fraction: Ratio = partial ? [PARTIAL.day, last] : [1, 1];
  const metrics = MONTHLY_HISTORY_METRICS[collection].map((def): MonthlyMetricValue => ({
    metricCode: def.metricCode, ...(def.variant ? { variant: def.variant } : {}),
    value: metricValue(def.metricCode, def.variant, rank - FIRST_RANK, source, aggregation, fraction),
  }));
  const day = partial ? PARTIAL.day : last;
  return { asOnDate: `${monthPeriod(year, month)}-${String(day).padStart(2, '0')}`, monthEnd: !partial, metrics };
}

/** Same ordering and shape as the Mongo reader: ascending period, then source, then aggregation. */
export function stubMonthlyHistory(agent: AgentRecord, req: MonthlyHistoryRequest): MonthlyHistory {
  const range = checkMonthlyRange(req.from, req.to);
  if (!range.ok) throw new Error('Invalid monthly history range');
  const records: MonthlyHistoryRecord[] = [];
  // EMPTY / PROCESSING demo agents have no history rows.
  const last = agent.demoDataState ? FIRST_RANK - 1 : Math.min(range.to.rank, PARTIAL_RANK);
  for (let rank = Math.max(range.from.rank, FIRST_RANK); rank <= last; rank += 1) {
    const year = Math.floor((rank - 1) / 12), month = rank - year * 12;
    for (const source of MONTHLY_HISTORY_SOURCES) {
      for (const aggregation of MONTHLY_HISTORY_AGGREGATIONS) {
        if (req.aggregation && req.aggregation !== aggregation) continue;
        records.push({
          period: monthPeriod(year, month), year, month, source, aggregation,
          production: part('my_production', rank, source, aggregation),
          mapa: part('my_mapa', rank, source, aggregation),
        });
      }
    }
  }
  return { agentId: agent.agentId, from: req.from, to: req.to, records };
}
