/**
 * ARVIJ-1450 monthly history (insights.v1 `getAgentMonthlyHistory`): pure helpers shared by the Mongo reader
 * (`PerformanceSource.monthlyHistory`) and the tests. See docs/monthly-history-source.md.
 *
 * One record per (period, source database, aggregation). Its value for a metric is the `ptd.<metric>.mtd` leaf
 * of ONE row per (collection, source, month, aggregation), chosen by the D2 rule in `compareMonthlyCandidates`.
 */
import type { Document } from 'mongodb';
import type { PerformanceCollection } from '../config/performance.js';
import { PERFORMANCE_METRIC_MAPPING, performanceMetricPath } from './performance-mapping.js';
import { performanceRecordMetadata } from './performance-record.js';
import { sourceMetricScalar } from './performance-values.js';
import type {
  MonthlyHistory, MonthlyHistoryAggregation, MonthlyHistoryPart, MonthlyHistoryRecord, MonthlyHistorySource,
  MonthlyMetricValue, Variant,
} from '../types.js';

/** Longest `from`..`to` span (inclusive months) one request may cover. */
export const MONTHLY_HISTORY_MAX_MONTHS = 48;
/** Both databases are always read; `entity` on a row equals its database key. Output order within a month. */
export const MONTHLY_HISTORY_SOURCES: readonly MonthlyHistorySource[] = ['PAMB', 'PBTB'];
/** Output order within a month and source. */
export const MONTHLY_HISTORY_AGGREGATIONS: readonly MonthlyHistoryAggregation[] = ['Personal', 'DirectUnit', 'Group'];
/** Persistency is YTD-only (no MTD leaf), so it is not part of the monthly history. */
export const MONTHLY_HISTORY_COLLECTIONS = ['my_production', 'my_mapa'] as const satisfies readonly PerformanceCollection[];
export type MonthlyHistoryCollection = typeof MONTHLY_HISTORY_COLLECTIONS[number];

/** Metrics emitted per collection, in output order. Paths come from `PERFORMANCE_METRIC_MAPPING` (MTD leaf). */
export const MONTHLY_HISTORY_METRICS: Readonly<Record<MonthlyHistoryCollection, ReadonlyArray<{ metricCode: string; variant?: Variant }>>> = {
  my_production: [
    { metricCode: 'TPC', variant: 'WITHOUT_REPRICING' }, { metricCode: 'TPC', variant: 'WITH_REPRICING' },
    { metricCode: 'PTPC', variant: 'WITHOUT_REPRICING' }, { metricCode: 'PTPC', variant: 'WITH_REPRICING' },
    { metricCode: 'FYP' }, { metricCode: 'FYC' }, { metricCode: 'CASE_COUNT' },
  ],
  my_mapa: [
    { metricCode: 'MANPOWER' }, { metricCode: 'ACTIVITY_RATIO' }, { metricCode: 'PRODUCTIVITY' },
    { metricCode: 'AVERAGE_CASE_SIZE' }, { metricCode: 'NEW_RECRUIT_CONTRACTED' },
  ],
};

export const isMonthlyAggregation = (value: unknown): value is MonthlyHistoryAggregation =>
  typeof value === 'string' && (MONTHLY_HISTORY_AGGREGATIONS as readonly string[]).includes(value);

export const monthPeriod = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`;
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface ParsedMonth { year: number; month: number; /** year * 12 + month, comparable across years. */ rank: number }

/** `YYYY-MM` (month 01..12) or undefined. */
export function parseMonth(value: unknown): ParsedMonth | undefined {
  const match = typeof value === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value) : null;
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]);
  return { year, month, rank: year * 12 + month };
}

export type MonthlyRangeCheck = { ok: true; from: ParsedMonth; to: ParsedMonth } | { ok: false; detail: string };

/** Shared by the HTTP route and the in-process domain client; `detail` is safe to return in a 400. */
export function checkMonthlyRange(from: unknown, to: unknown): MonthlyRangeCheck {
  if (typeof from !== 'string' || from === '') return { ok: false, detail: 'from is required (YYYY-MM)' };
  if (typeof to !== 'string' || to === '') return { ok: false, detail: 'to is required (YYYY-MM)' };
  const f = parseMonth(from);
  if (!f) return { ok: false, detail: `from=${from.slice(0, 16)}` };
  const t = parseMonth(to);
  if (!t) return { ok: false, detail: `to=${to.slice(0, 16)}` };
  if (f.rank > t.rank) return { ok: false, detail: 'from must not be after to' };
  const span = t.rank - f.rank + 1;
  if (span > MONTHLY_HISTORY_MAX_MONTHS) return { ok: false, detail: `range spans ${span} months; the maximum is ${MONTHLY_HISTORY_MAX_MONTHS}` };
  return { ok: true, from: f, to: t };
}

/**
 * `isMonthEnd` is a String in the source ('Y' on month-end rows, null otherwise). Spelling is pending data-owner
 * confirmation, so y/yes/true/1 (any case) are accepted; null, undefined and anything else are false.
 */
export const isMonthEndFlag = (value: unknown): boolean => /^(y|yes|true|1)$/i.test(String(value ?? '').trim());

const at = (row: Document, path: string): unknown =>
  path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Document)[key] : undefined, row);

/** A source row with the fields the D2 selection ranks on (never exposed). */
export interface MonthlyRowCandidate {
  row: Document;
  year: number;
  month: number;
  aggregation: MonthlyHistoryAggregation;
  /** Declared as-on day of month (`period.asOnMonthDay`: Int, UTC Date or numeric string), when present. */
  day?: number;
  /** Epoch ms of the `asOnDate` load watermark: internal, only a D2 tie-break (never returned). */
  asOnTime: number;
  flagged: boolean;
  id?: string;
}

/** Throws the sanitized "Performance source metadata is invalid" error when period/asOnDate are malformed. */
export function monthlyCandidate(row: Document): MonthlyRowCandidate {
  const meta = performanceRecordMetadata(row);
  const aggregation: unknown = row.agentAggregation;
  if (!isMonthlyAggregation(aggregation)) throw new Error('Unsupported aggregation');
  const raw: unknown = row.asOnDate;
  return {
    row, year: meta.year, month: meta.month, aggregation,
    ...(meta.day !== undefined ? { day: meta.day } : {}),
    asOnTime: new Date(raw instanceof Date ? raw : String(raw)).getTime(),
    flagged: isMonthEndFlag(row.isMonthEnd),
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
  };
}

/**
 * D2 (negative ⇒ `a` is preferred): month-end-flagged row first, else greatest declared as-on day (a row that
 * declares none ranks below one that does), else greatest `asOnDate`, then `id` descending. Remaining ties keep
 * input order, which the reader makes `_id` descending (same tie-break as the dashboard's `latest()`).
 */
export function compareMonthlyCandidates(a: MonthlyRowCandidate, b: MonthlyRowCandidate): number {
  if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
  const ad = a.day ?? -1, bd = b.day ?? -1;
  if (ad !== bd) return bd - ad;
  if (a.asOnTime !== b.asOnTime) return b.asOnTime - a.asOnTime;
  const ai = a.id ?? '', bi = b.id ?? '';
  return ai === bi ? 0 : ai > bi ? -1 : 1;
}

export function selectMonthlyRow(candidates: readonly MonthlyRowCandidate[]): MonthlyRowCandidate | undefined {
  // Array.prototype.sort is stable, so equal candidates stay in input order.
  return [...candidates].sort(compareMonthlyCandidates)[0];
}

/** Parses the rows of one query, keeping only months inside the range; malformed rows are counted, not returned. */
export function monthlyCandidates(rows: readonly Document[], from: ParsedMonth, to: ParsedMonth): { candidates: MonthlyRowCandidate[]; skipped: number } {
  const candidates: MonthlyRowCandidate[] = [];
  let skipped = 0;
  for (const row of rows) {
    let candidate: MonthlyRowCandidate;
    try { candidate = monthlyCandidate(row); } catch { skipped += 1; continue; }
    const rank = candidate.year * 12 + candidate.month;
    if (rank >= from.rank && rank <= to.rank) candidates.push(candidate);
  }
  return { candidates, skipped };
}

/** MTD leaf of every metric of `collection` for the selected row; unavailable/invalid values are `null`. */
export function monthlyPart(collection: MonthlyHistoryCollection, chosen: MonthlyRowCandidate): MonthlyHistoryPart {
  const metrics = MONTHLY_HISTORY_METRICS[collection].map((def): MonthlyMetricValue => {
    const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
    const path = mapping ? performanceMetricPath(mapping, 'MTD', def.variant === 'WITH_REPRICING') : undefined;
    const value = mapping && path ? sourceMetricScalar(mapping.valueType, at(chosen.row, path), mapping.fraction) : undefined;
    return { metricCode: def.metricCode, ...(def.variant ? { variant: def.variant } : {}), value: value ?? null };
  });
  // In-month as-on date: the period's year-month with the declared as-on day (the month's last day when undeclared).
  // Never the `asOnDate` load watermark, which is the pipeline run date and can be a year after the month
  // (the same rule as the dashboard's AC-PA-DIRECT-29).
  const last = daysInMonth(chosen.year, chosen.month);
  return {
    asOnDate: `${monthPeriod(chosen.year, chosen.month)}-${String(chosen.day ?? last).padStart(2, '0')}`,
    monthEnd: chosen.flagged || chosen.day === last,
    metrics,
  };
}

export interface MonthlyHistoryInput { source: MonthlyHistorySource; collection: MonthlyHistoryCollection; candidates: readonly MonthlyRowCandidate[] }

/** Picks one row per (collection, source, month, aggregation) and merges the collections into records (months without a row are absent). */
export function assembleMonthlyHistory(agentId: string, from: string, to: string, inputs: readonly MonthlyHistoryInput[]): MonthlyHistory {
  const records = new Map<string, MonthlyHistoryRecord>();
  for (const { source, collection, candidates } of inputs) {
    const groups = new Map<string, MonthlyRowCandidate[]>();
    for (const c of candidates) {
      const key = `${c.year}|${c.month}|${c.aggregation}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const group of groups.values()) {
      const chosen = selectMonthlyRow(group)!;
      const key = `${source}|${chosen.year}|${chosen.month}|${chosen.aggregation}`;
      const record = records.get(key) ?? {
        period: monthPeriod(chosen.year, chosen.month), year: chosen.year, month: chosen.month,
        source, aggregation: chosen.aggregation, production: null, mapa: null,
      };
      if (collection === 'my_production') record.production = monthlyPart(collection, chosen);
      else record.mapa = monthlyPart(collection, chosen);
      records.set(key, record);
    }
  }
  const order = <T>(list: readonly T[], value: T) => list.indexOf(value);
  return {
    agentId, from, to,
    records: [...records.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month)
      || (order(MONTHLY_HISTORY_SOURCES, a.source) - order(MONTHLY_HISTORY_SOURCES, b.source))
      || (order(MONTHLY_HISTORY_AGGREGATIONS, a.aggregation) - order(MONTHLY_HISTORY_AGGREGATIONS, b.aggregation))),
  };
}
