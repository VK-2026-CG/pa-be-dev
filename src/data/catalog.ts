import type { MetricDefinition } from '../types.js';

const P: MetricDefinition['dimensions']['periods'] = ['MTD', 'QTD', 'YTD'];
const BL: MetricDefinition['dimensions']['businessLines'] = ['ALL', 'INSURANCE', 'TAKAFUL'];
const B: MetricDefinition['dimensions']['basis'] = ['STANDARD', 'SCHEME'];
const cap = (o: Partial<MetricDefinition['capabilities']>): MetricDefinition['capabilities'] => ({
  goal: false, penders: false, repricing: false, breakdown: false, threshold: false, history: false, ...o,
});

/**
 * MY seed — mirrors pruaction-spec domains/insights/data/mongodb.md §4 (v1.3.0).
 * SCHEME segmentOverrides are a PLACEHOLDER pending OQ-20 (Scheme set/order/goals
 * unconfirmed): stubbed as the smaller re-ordered set [TPC, FYP, CASE_COUNT].
 * `scheme_type` arrives null from the declared upstream source, so `basis=SCHEME`
 * stays unbacked regardless of a metric's own availability (source-mapping.md
 * OQ-PA-07) — the overrides below remain a placeholder, not a mapping.
 *
 * Legacy `availability` annotations are not consulted by the three-collection
 * adapter. Readiness is determined per source value/lens; absent values are EMPTY.
 * This module supplies static catalogue definitions, never a Mongo collection.
 *
 * APE and API are catalogued in the spec as `CANDIDATE` but are deliberately NOT
 * in this runtime catalogue: §4.1 requires that they MUST NOT be enabled in a
 * country config until `content/en.json` carries their title keys (a missing i18n
 * key fails the FE suite). Add them only alongside country config + i18n copy.
 */
export const CATALOG: MetricDefinition[] = [
  { metricCode: 'TPC', availability: 'BACKED', valueType: 'MONEY', currency: 'MYR', category: 'PRIORITY', defaultSelected: true, defaultOrder: 1, customizable: false,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ goal: true, penders: true, repricing: true, breakdown: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { defaultOrder: 1 } } },
  { metricCode: 'PTPC', availability: 'BACKED', valueType: 'MONEY', currency: 'MYR', category: 'PRIORITY', defaultSelected: true, defaultOrder: 2, customizable: false,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ penders: true, repricing: true, breakdown: true }),
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { included: false } } },
  { metricCode: 'CASE_COUNT', availability: 'BACKED', valueType: 'COUNT', category: 'PRIORITY', defaultSelected: true, defaultOrder: 3, customizable: false,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ goal: true, penders: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { defaultOrder: 3 } } },
  // v1.11.0 (pruaction-spec S-P4-02, ARVIJ-107/165 AC-P4-02-40): breakdown
  // enabled — 7-product set (below), NOT TPC/PTPC's narrowed 5. No repricing
  // capability, so `breakdown()` emits WITHOUT_REPRICING only and CREDIT_POINTS
  // stays a plain weighted row (never the capped TPC/PTPC formula).
  { metricCode: 'FYP', availability: 'BACKED', valueType: 'MONEY', currency: 'MYR', category: 'PRIORITY', defaultSelected: true, defaultOrder: 4, customizable: false,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ goal: true, penders: true, breakdown: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { defaultOrder: 2 } } },
  { metricCode: 'MANPOWER', availability: 'UNBACKED', valueType: 'COUNT', category: 'PRIORITY', defaultSelected: true, defaultOrder: 5, customizable: false,
    // S-P4-02 v1.13.0 (ARVIJ-159, AC-P4-02-44): change is always shown as % — was ABS.
    scopes: ['TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ barComparison: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: ['STANDARD'] } },
  { metricCode: 'ACTIVITY_RATIO', availability: 'UNBACKED', valueType: 'PERCENT', category: 'PRIORITY', defaultSelected: true, defaultOrder: 6, customizable: false,
    // S-P4-02 v1.14.0 (ARVIJ-160, AC-P4-02-48): change is a relative % of the ratio — was PP.
    scopes: ['TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ threshold: true, history: true }), threshold: { value: 90, comparator: 'GTE' },
    dimensions: { periods: P, businessLines: BL, basis: ['STANDARD'] } },
  { metricCode: 'PRODUCTIVITY', availability: 'UNBACKED', valueType: 'DECIMAL', category: 'PRIORITY', defaultSelected: true, defaultOrder: 7, customizable: false,
    // ABS -> PCT: S-P4-02 v1.15.0 (ARVIJ-161, AC-P4-02-50). Stays a gauge — the bar-chart ask is OQ-66.
    scopes: ['TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ history: true }),
    dimensions: { periods: P, businessLines: BL, basis: ['STANDARD'] } },
  { metricCode: 'AVERAGE_CASE_SIZE', availability: 'UNBACKED', valueType: 'MONEY', currency: 'MYR', category: 'PRIORITY', defaultSelected: true, defaultOrder: 8, customizable: false,
    // ABS -> PCT: S-P4-02 v1.16.0 (ARVIJ-162, AC-P4-02-52). Stays a gauge — the bar-chart ask is OQ-66.
    scopes: ['TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ history: true }),
    dimensions: { periods: P, businessLines: BL, basis: ['STANDARD'] } },
  { metricCode: 'NEW_RECRUIT_CONTRACTED', availability: 'UNBACKED', valueType: 'COUNT', category: 'FOCUS', defaultSelected: false, defaultOrder: 5, customizable: true,
    scopes: ['SELF', 'TEAM'],
    favourability: 'HIGHER_IS_BETTER', changeDisplay: 'ABS',
    capabilities: cap({ barComparison: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: ['STANDARD'] } },
  { metricCode: 'FYC', availability: 'UNBACKED', valueType: 'MONEY', currency: 'MYR', category: 'FOCUS', defaultSelected: true, defaultOrder: 1, customizable: true,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ goal: true, penders: true, history: true }),
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { included: false } } },
  { metricCode: 'PERSISTENCY_CY', availability: 'UNBACKED', valueType: 'PERCENT', category: 'FOCUS', defaultSelected: true, defaultOrder: 2, customizable: true,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ threshold: true, history: true }), threshold: { value: 90, comparator: 'GTE' },
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { included: false } } },
  { metricCode: 'PERSISTENCY_Y1', availability: 'UNBACKED', valueType: 'PERCENT', category: 'FOCUS', defaultSelected: false, defaultOrder: 3, customizable: true,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ threshold: true, history: true }), threshold: { value: 85, comparator: 'GTE' },
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { included: false } } },
  { metricCode: 'PERSISTENCY_Y2', availability: 'UNBACKED', valueType: 'PERCENT', category: 'FOCUS', defaultSelected: false, defaultOrder: 4, customizable: true,
    scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT',
    capabilities: cap({ threshold: true, history: true }), threshold: { value: 80, comparator: 'GTE' },
    dimensions: { periods: P, businessLines: BL, basis: B },
    segmentOverrides: { SCHEME: { included: false } } },
];

export interface EffectiveDef extends MetricDefinition { effCategory: 'PRIORITY' | 'FOCUS'; effOrder: number; effSelected: boolean }

/** Resolve the catalog for a (scope, basis) lens: membership + category/order after overrides (D-12, D-13). */
export function effectiveCatalog(scope: 'SELF' | 'TEAM', basis: 'STANDARD' | 'SCHEME'): EffectiveDef[] {
  return CATALOG.filter((d) => d.scopes.includes(scope))
    .filter((d) => (d.segmentOverrides?.[basis]?.included ?? true) && d.dimensions.basis.includes(basis))
    .map((d) => {
      const so = d.scopeOverrides?.[scope];
      const seg = d.segmentOverrides?.[basis];
      return {
        ...d,
        effCategory: seg?.category ?? so?.category ?? d.category,
        effOrder: seg?.defaultOrder ?? so?.defaultOrder ?? d.defaultOrder,
        effSelected: seg?.defaultSelected ?? so?.defaultSelected ?? d.defaultSelected,
      };
    })
    .sort((a, b) => a.effOrder - b.effOrder);
}
export function findDef(code: string): MetricDefinition | undefined {
  return CATALOG.find((d) => d.metricCode === code);
}
