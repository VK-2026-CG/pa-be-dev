import type { PeriodType, ScalarKind, Variant } from '../types.js';
import type { PerformanceCollection } from '../config/performance.js';

export interface PerformanceMetricMapping {
  collection: PerformanceCollection;
  valueType: ScalarKind;
  /** {period} is the exact mtd/qtd/ytd leaf, never a derived total. */
  path: string;
  alternatePath?: string;
  periods: readonly PeriodType[];
  fraction?: boolean;
}
const PERIODS: readonly PeriodType[] = ['MTD', 'QTD', 'YTD'];
const production = (path: string, valueType: ScalarKind = 'MONEY'): PerformanceMetricMapping =>
  ({ collection: 'my_production', path: `ptd.${path}.{period}`, valueType, periods: PERIODS });
const mapa = (path: string, valueType: ScalarKind): PerformanceMetricMapping =>
  ({ collection: 'my_mapa', path: `ptd.${path}.{period}`, valueType, periods: PERIODS });
const persistency = (path: string): PerformanceMetricMapping =>
  ({ collection: 'my_persistency', path: `metrics.ytd.${path}`, valueType: 'PERCENT', periods: ['YTD'], fraction: true });

/** SPEC-2026-002: explicit source paths, independent of any imported sample identity. */
export const PERFORMANCE_METRIC_MAPPING: Readonly<Record<string, PerformanceMetricMapping>> = {
  TPC: { ...production('tpc.withoutRepricing'), alternatePath: 'ptd.tpc.withRepricing.{period}' },
  PTPC: { ...production('ptpc.withoutRepricing'), alternatePath: 'ptd.ptpc.withRepricing.{period}' },
  FYP: production('fyp'), FYC: production('fyc'), CASE_COUNT: production('caseCount.total', 'COUNT'),
  MANPOWER: mapa('manpowerTotal', 'COUNT'), ACTIVITY_RATIO: mapa('activityRatio', 'PERCENT'),
  PRODUCTIVITY: mapa('productivity', 'DECIMAL'), AVERAGE_CASE_SIZE: mapa('averageCaseSize', 'MONEY'),
  NEW_RECRUIT_CONTRACTED: mapa('newRecruits', 'COUNT'),
  PERSISTENCY_CY: persistency('currentYearPersistency'),
  PERSISTENCY_Y1: persistency('firstYearPersistency'), PERSISTENCY_Y2: persistency('secondYearPersistency'),
};

/**
 * Breakdown by product (S-P4-02): the product leaves sit beside the metric's own period leaf, e.g.
 * `ptd.tpc.withoutRepricing.linked.ytd` next to `ptd.tpc.withoutRepricing.ytd`. The spec's product LOV
 * (source-mapping.md §2.4) is closed to these four leaves; UNIT_TRUST/GROUP_PREMIUM have no source leaf and
 * stay absent. `my_production` also carries `snapshot.tpc.<variant>.creditPoint`, but that is a single
 * point-in-time value with no period leaf, so Credit Points is derived (see performance-breakdown.ts).
 */
export const PERFORMANCE_PRODUCT_LEAVES = [
  { leaf: 'linked', productCode: 'LINKED_PREMIUM' },
  { leaf: 'regular', productCode: 'REGULAR_PREMIUM' },
  { leaf: 'psa', productCode: 'PSA' },
  { leaf: 'sp', productCode: 'SINGLE_PREMIUM' },
] as const;

export interface PerformanceBreakdownMapping {
  collection: PerformanceCollection;
  /** Variant object holding the product leaves; FYP has no repricing variants, so only WITHOUT_REPRICING. */
  variants: Readonly<Partial<Record<Variant, string>>>;
  /** TPC/PTPC (repricing-capable) also get the derived CREDIT_POINTS row (AC-P4-02-33); FYP does not (AC-P4-02-40). */
  creditPoints: boolean;
}
export const PERFORMANCE_BREAKDOWN_MAPPING: Readonly<Record<string, PerformanceBreakdownMapping>> = {
  TPC: { collection: 'my_production', creditPoints: true, variants: { WITHOUT_REPRICING: 'ptd.tpc.withoutRepricing', WITH_REPRICING: 'ptd.tpc.withRepricing' } },
  PTPC: { collection: 'my_production', creditPoints: true, variants: { WITHOUT_REPRICING: 'ptd.ptpc.withoutRepricing', WITH_REPRICING: 'ptd.ptpc.withRepricing' } },
  FYP: { collection: 'my_production', creditPoints: false, variants: { WITHOUT_REPRICING: 'ptd.fyp' } },
};

/** `{base}.{leaf}.{period}` — the exact mtd/qtd/ytd leaf, never a sum of periods or a snapshot value. */
export function performanceProductPath(base: string, leaf: string, period: PeriodType): string {
  return `${base}.${leaf}.${period.toLowerCase()}`;
}

export interface PerformanceSourceKeys {
  identity: string; aggregation: string; status: string; type: string; caseStatus: string;
}
/** Same field names across both databases and all three collections. `type` (agentType) genuinely
 * varies per agent ('PAMB' vs also-Takaful-licensed 'HYBRID' in PAMB, always 'Takaful' in PBTB), but
 * isn't used for businessLine filtering yet — see the interim note on `entityFor` in performance-source.ts. */
export const PERFORMANCE_SOURCE_KEYS: Record<PerformanceCollection, PerformanceSourceKeys> = {
  my_production: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
  my_mapa: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
  my_persistency: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
};

/**
 * SPEC-2026-002 0.4.0-draft: temporary widening — accept both spellings while an
 * upstream data-correction is in progress (owned by the requester). Revisit once
 * that correction lands and the permanent value(s) are confirmed.
 */
export const PERFORMANCE_ACTIVE_STATUS_VALUES = ['Active', 'A'] as const;

export function performanceMetricPath(mapping: PerformanceMetricMapping, period: PeriodType, alternate = false): string | undefined {
  if (!mapping.periods.includes(period)) return undefined;
  return (alternate ? mapping.alternatePath : mapping.path)?.replace('{period}', period.toLowerCase());
}