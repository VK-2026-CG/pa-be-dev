/**
 * S-P4-03 v2.0.0 Historical Data (ARVIJ-1450), TEAM and SELF on the same screen: composes `HistoricalDataVM` from ONE `monthlyHistory` domain read.
 * The domain returns month-level values per source database; choosing the source (businessLine) and doing the
 * comparison arithmetic are BFF concerns, so nothing is summed across databases.
 */
import type {
  BusinessLine, Basis, DeltaVM, HistoricalComparison, HistoricalDataRowVM, HistoricalDataTotalsVM, HistoricalDataVM, MetricScalar, Scope, TeamView, Variant,
} from '../../../vendor/spec/performance-vm.js';
import { findDef } from '../../data/catalog.js';
import { PERFORMANCE_METRIC_MAPPING } from '../../data/performance-mapping.js';
import { fromCents, toCents } from '../../lib/money.js';
import type { MonthlyHistoryAggregation, MonthlyHistorySource } from '../../types.js';
import { CONFIG } from '../config.js';
import type { DomainApi } from '../domain-client.js';
import type { Persona } from '../persona.js';
import { buildMeta } from './shared.js';

export interface HistoricalDataParams {
  /** SELF reads the agent's own Personal rows; TEAM reads DirectUnit / Group by `teamView`. */
  scope: Scope;
  metricCode: string;
  /** TPC only (the caller has already rejected a variant on any other metric). */
  variant?: Variant;
  comparison: HistoricalComparison;
  businessLine: BusinessLine;
  /** TEAM only (ignored for SELF); defaults to DIRECT. */
  teamView?: TeamView;
  basis: Basis;
}

/** Exact decimal: `coef / 10^scale`. */
interface Decimal { coef: bigint; scale: number }

function decimalOf(value: MetricScalar): Decimal | undefined {
  // Money on integer cents (D-04) — never parseFloat.
  if (value.kind === 'MONEY') return { coef: toCents(value.amount), scale: 2 };
  if (!Number.isFinite(value.value)) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value.value));
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  let coef = BigInt(match[2]! + fraction);
  let scale = fraction.length - Number(match[4] ?? 0);
  if (scale < 0) { coef *= 10n ** BigInt(-scale); scale = 0; }
  return { coef: match[1] ? -coef : coef, scale };
}

/**
 * `((current - prior) / prior) * 100`, one decimal, rounded half away from zero (not the R-PCT-ROUNDUP integer rule),
 * computed exactly on integers. Null when the percentage is undefined: a zero prior or mismatched/invalid scalars.
 */
export function pctChangeOneDecimal(current: MetricScalar, prior: MetricScalar): number | null {
  if (current.kind !== prior.kind) return null;
  const c = decimalOf(current), p = decimalOf(prior);
  if (!c || !p) return null;
  const scale = Math.max(c.scale, p.scale);
  const cur = c.coef * 10n ** BigInt(scale - c.scale);
  const pri = p.coef * 10n ** BigInt(scale - p.scale);
  if (pri === 0n) return null;
  const numerator = (cur - pri) * 1000n; // tenths of a percent, before the division
  const negative = (numerator < 0n) !== (pri < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = pri < 0n ? -pri : pri;
  const magnitude = (2n * n + d) / (2n * d); // floor(n/d + 1/2) on magnitudes ⇒ half away from zero
  return Number(negative ? -magnitude : magnitude) / 10;
}

type Favourability = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

/** Direction and sentiment follow the ROUNDED percentage; sentiment inverts only for LOWER_IS_BETTER metrics. */
function changeOf(
  current: MetricScalar | null | undefined, prior: MetricScalar | null | undefined,
  basis: DeltaVM['comparisonBasis'], favourability: Favourability,
): DeltaVM | null {
  if (!current || !prior) return null;
  const pct = pctChangeOneDecimal(current, prior);
  if (pct === null) return null;
  const good = favourability === 'LOWER_IS_BETTER' ? pct < 0 : pct > 0;
  return {
    comparisonBasis: basis,
    direction: pct === 0 ? 'FLAT' : pct > 0 ? 'UP' : 'DOWN',
    sentiment: pct === 0 ? 'NEUTRAL' : good ? 'POSITIVE' : 'NEGATIVE',
    display: 'PCT',
    pct,
  };
}

/** Sum of additive scalars of one kind, exact: money on integer cents, counts as integers. Other kinds are not additive. */
function sumScalars(values: readonly MetricScalar[]): MetricScalar | null {
  const first = values[0];
  if (!first) return null;
  if (first.kind === 'MONEY') {
    let cents = 0n;
    for (const v of values) { if (v.kind !== 'MONEY') return null; cents += toCents(v.amount); }
    return { kind: 'MONEY', amount: fromCents(cents), currency: first.currency };
  }
  if (first.kind === 'COUNT') {
    let total = 0;
    for (const v of values) { if (v.kind !== 'COUNT') return null; total += v.value; }
    return { kind: 'COUNT', value: total };
  }
  return null;
}

/** Interim rule, same as the dashboard: INSURANCE and ALL read PAMB, TAKAFUL reads PBTB. */
export const historicalSourceFor = (businessLine: BusinessLine): MonthlyHistorySource => businessLine === 'TAKAFUL' ? 'PBTB' : 'PAMB';
export const historicalAggregationFor = (scope: Scope, teamView: TeamView | undefined): MonthlyHistoryAggregation =>
  scope === 'SELF' ? 'Personal' : teamView === 'GROUP' ? 'Group' : 'DirectUnit';

const monthKey = (year: number, month: number): string => `${year}-${month}`;

export async function composeHistoricalData(
  domain: DomainApi, persona: Persona, params: HistoricalDataParams, now: Date = new Date(),
): Promise<HistoricalDataVM> {
  const cfg = CONFIG.screens.historicalData;
  const { metricCode, variant, comparison } = params;
  const source = historicalSourceFor(params.businessLine);
  const scope: Scope = params.scope === 'SELF' ? 'SELF' : 'TEAM';
  const teamView: TeamView = params.teamView ?? 'DIRECT';
  const aggregation = historicalAggregationFor(scope, teamView);
  // The SELF view is the same screen with its own metric set (config `self`); TEAM uses the screen's main list.
  const metricOptions = scope === 'SELF' ? cfg.self?.metrics ?? [] : cfg.metrics;
  const clockYear = now.getUTCFullYear();

  // One read for the whole window: lookbackYears prior years + the clock year (<= 48 months).
  const history = await domain.monthlyHistory(persona.agentId, persona.agentId, {
    from: `${clockYear - cfg.lookbackYears}-01`, to: `${clockYear}-12`, aggregation,
  });
  const records = history.records.filter((r) => r.source === source && r.aggregation === aggregation);

  // Anchor = year of the newest record of the chosen source (any collection); none ⇒ clock year, EMPTY.
  const anchorYear = records.reduce((year, r) => Math.max(year, r.year), Number.NEGATIVE_INFINITY);
  const anchor = Number.isFinite(anchorYear) ? anchorYear : clockYear;

  const owner = PERFORMANCE_METRIC_MAPPING[metricCode]?.collection === 'my_mapa' ? 'mapa' : 'production';
  const cells = new Map<string, MetricScalar>();
  for (const record of records) {
    const found = record[owner]?.metrics.find((m) => m.metricCode === metricCode && m.variant === variant);
    if (found?.value) cells.set(monthKey(record.year, record.month), found.value);
  }
  const valueAt = (year: number, month: number): MetricScalar | null => cells.get(monthKey(year, month)) ?? null;

  const def = findDef(metricCode);
  const favourability: Favourability = def?.favourability ?? 'HIGHER_IS_BETTER';

  // Per the Jira stories (requester decision "go as per the user story"): CURRENT_YEAR (AC7) is month-over-month, and
  // January compares with the previous December; VS_LAST_YEAR (AC8) and VS_LAST_2_YEARS (AC9) compare the same month
  // of the previous year(s).
  const years = comparison === 'CURRENT_YEAR' ? [anchor] : comparison === 'VS_LAST_YEAR' ? [anchor, anchor - 1] : [anchor, anchor - 1, anchor - 2];
  const changeColumns: HistoricalDataVM['changeColumns'] = comparison === 'CURRENT_YEAR' ? [{ basis: 'LAST_MONTH' }]
    : comparison === 'VS_LAST_YEAR' ? [{ basis: 'LAST_YEAR' }]
      : [{ basis: 'LAST_YEAR' }, { basis: 'LAST_2_YEARS' }];

  const rows: HistoricalDataRowVM[] = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const current = valueAt(anchor, month);
    const changes: Array<DeltaVM | null> = comparison === 'CURRENT_YEAR'
      // AC-P4-03-31: January compares with the previous December ("previous month").
      ? [changeOf(current, month === 1 ? valueAt(anchor - 1, 12) : valueAt(anchor, month - 1), 'LAST_MONTH', favourability)]
      : comparison === 'VS_LAST_YEAR'
        ? [changeOf(current, valueAt(anchor - 1, month), 'LAST_YEAR', favourability)]
        : [
          changeOf(current, valueAt(anchor - 1, month), 'LAST_YEAR', favourability),
          changeOf(current, valueAt(anchor - 2, month), 'LAST_2_YEARS', favourability),
        ];
    return { month, values: years.map((year) => valueAt(year, month)), changes };
  });

  // Desktop Total row (AC-P4-03-32), additive metrics only (config `total: true`). Like-for-like: every year sums only
  // the months M in which the anchor year has a value; a year lacking a value in any month of M has no total (never a
  // partial sum). The % change of a total compares equal periods; a LAST_MONTH change of a total is undefined (null).
  const totalable = metricOptions.some((m) => m.metricCode === metricCode && m.variant === variant && m.total === true);
  let totals: HistoricalDataTotalsVM | undefined;
  if (totalable) {
    const months = rows.filter((row) => row.values[0] !== null).map((row) => row.month);
    const totalOf = (year: number): MetricScalar | null => {
      const parts = months.map((month) => valueAt(year, month));
      return months.length > 0 && parts.every((part) => part !== null) ? sumScalars(parts as MetricScalar[]) : null;
    };
    const values = years.map(totalOf);
    totals = {
      values,
      changes: changeColumns.map(({ basis }) => {
        if (basis === 'LAST_MONTH') return null;
        const prior = basis === 'LAST_YEAR' ? years.indexOf(anchor - 1) : years.indexOf(anchor - 2);
        return prior < 0 ? null : changeOf(values[0], values[prior], basis, favourability);
      }),
    };
  }

  // Newest part as-on date of the chosen source. Parts carry the in-month as-on date, never the load watermark.
  const asOfDate = records.flatMap((r) => [r.production?.asOnDate, r.mapa?.asOnDate])
    .reduce<string | undefined>((newest, date) => date !== undefined && (newest === undefined || date > newest) ? date : newest, undefined)
    ?? now.toISOString().slice(0, 10);

  return {
    meta: buildMeta(cfg.screenId, asOfDate),
    dataState: rows.every((row) => row.values.every((value) => value === null)) ? 'EMPTY' : 'OK',
    context: { businessLine: params.businessLine, basis: params.basis, scope, ...(scope === 'TEAM' ? { teamView } : {}) },
    selection: { metricCode, ...(variant ? { variant } : {}), comparison },
    filter: {
      metrics: metricOptions.map((m) => ({
        metricCode: m.metricCode, ...(m.variant ? { variant: m.variant } : {}),
        selected: m.metricCode === metricCode && m.variant === variant,
      })),
      comparisons: cfg.comparisons.map((c) => ({ comparison: c, selected: c === comparison })),
    },
    valueType: def?.valueType ?? PERFORMANCE_METRIC_MAPPING[metricCode]?.valueType ?? 'MONEY',
    anchorYear: anchor,
    years,
    changeColumns,
    rows,
    ...(totals ? { totals } : {}),
  };
}
