import type { PeriodType, ScalarKind } from '../types.js';
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
  PERSISTENCY_CY: persistency('current_year_persistency'),
  PERSISTENCY_Y1: persistency('first_year_persistency'), PERSISTENCY_Y2: persistency('second_year_persistency'),
};

export const PERFORMANCE_SOURCE_KEYS: Record<PerformanceCollection, { identity: string; aggregation: string }> = {
  my_production: { identity: 'agent_id', aggregation: 'agent_aggregation' },
  my_mapa: { identity: 'agentId', aggregation: 'agentAggregation' },
  my_persistency: { identity: 'agentId', aggregation: 'agentAggregation' },
};

export function performanceMetricPath(mapping: PerformanceMetricMapping, period: PeriodType, alternate = false): string | undefined {
  if (!mapping.periods.includes(period)) return undefined;
  return (alternate ? mapping.alternatePath : mapping.path)?.replace('{period}', period.toLowerCase());
}