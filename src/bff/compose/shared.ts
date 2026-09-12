import type {
  DeltaVM, MetricScalar, PeriodType, Scope, TeamView, VMeta,
} from '../../../vendor/spec/performance-vm.js';
import { CONFIG } from '../config.js';

export const SPEC_VERSION = '1.3.0';

let traceCounter = 0;
export function buildMeta(screenId: string, asOfDate: string, partial = false, failedSections?: string[]): VMeta {
  traceCounter += 1;
  return {
    screenId,
    specVersion: SPEC_VERSION,
    configVersion: CONFIG.configVersion,
    country: CONFIG.country,
    asOfDate,
    generatedAt: new Date().toISOString(),
    traceId: `bff-${Date.now()}-${traceCounter}`,
    partial,
    ...(failedSections?.length ? { failedSections } : {}),
  };
}

/** Domain `Change` (spec insights.v1) — structurally what the service emits. */
export interface DomainChange {
  basis: 'LAST_YEAR';
  direction: 'UP' | 'DOWN' | 'FLAT';
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  pct?: number;
  pp?: number;
  abs?: MetricScalar;
}

/** Map a domain change to DeltaVM, adding `display` (D-10) from the payload shape. */
export function mapChange(c: DomainChange): DeltaVM {
  const display: DeltaVM['display'] = c.abs !== undefined ? 'ABS' : c.pp !== undefined ? 'PP' : 'PCT';
  return {
    comparisonBasis: 'LAST_YEAR',
    direction: c.direction,
    sentiment: c.sentiment,
    display,
    ...(c.pct !== undefined ? { pct: c.pct } : {}),
    ...(c.pp !== undefined ? { pp: c.pp } : {}),
    ...(c.abs !== undefined ? { abs: c.abs } : {}),
  };
}

/** Period window starts for the Time Period sheet (BFF-supplied — clients do no fiscal math). */
export function periodOptionsMeta(asOfDate: string, options: PeriodType[]): Array<{ period: PeriodType; startDate: string }> {
  const [y = '2026', m = '01'] = asOfDate.split('-');
  const month = Number(m);
  const q = Math.floor((month - 1) / 3) * 3 + 1;
  const starts: Record<PeriodType, string> = {
    YTD: `${y}-01-01`,
    QTD: `${y}-${String(q).padStart(2, '0')}-01`,
    MTD: `${y}-${m}-01`,
  };
  return options.map((period) => ({ period, startDate: starts[period] }));
}

export interface LensInput {
  period: PeriodType;
  businessLine: 'ALL' | 'INSURANCE' | 'TAKAFUL';
  basis: 'STANDARD' | 'SCHEME';
  scope: Scope;
  teamView?: TeamView;
}

/** Domain metric-definition shape (subset the composers use). */
export interface DomainDef {
  metricCode: string;
  valueType: MetricScalar['kind'];
  category: 'PRIORITY' | 'FOCUS';
  defaultSelected: boolean;
  defaultOrder: number;
  customizable: boolean;
  scopes: Scope[];
  scopeOverrides?: Partial<Record<Scope, { category?: 'PRIORITY' | 'FOCUS'; defaultSelected?: boolean; defaultOrder?: number }>>;
  segmentOverrides?: Partial<Record<'STANDARD' | 'SCHEME', { included?: boolean; category?: 'PRIORITY' | 'FOCUS'; defaultSelected?: boolean; defaultOrder?: number }>>;
  favourability: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  changeDisplay: 'PCT' | 'PP' | 'ABS';
  capabilities: Record<string, boolean>;
}

export interface EffectiveDef extends DomainDef { effCategory: 'PRIORITY' | 'FOCUS'; effOrder: number; effSelected: boolean }

/** Mirror of the domain's catalog resolution (D-12/D-13) for client-side list building. */
export function effectiveDefs(defs: DomainDef[], scope: Scope, basis: 'STANDARD' | 'SCHEME'): EffectiveDef[] {
  return defs
    .filter((d) => d.scopes.includes(scope))
    .filter((d) => d.segmentOverrides?.[basis]?.included !== false)
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
