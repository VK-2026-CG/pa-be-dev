/** Domain types mirroring vendor/spec/insights.v1.yaml (v1.3.0). Field names are the contract — do not rename. */
export type PeriodType = 'MTD' | 'QTD' | 'YTD';
export type BusinessLine = 'ALL' | 'INSURANCE' | 'TAKAFUL';
export type Basis = 'STANDARD' | 'SCHEME';
export type Scope = 'SELF' | 'TEAM';
export type TeamView = 'DIRECT' | 'GROUP';
export type Variant = 'WITHOUT_REPRICING' | 'WITH_REPRICING';
export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
export type TrendDirection = 'UP' | 'DOWN' | 'FLAT';
export type ScalarKind = 'MONEY' | 'COUNT' | 'PERCENT' | 'DECIMAL';

export type MetricScalar =
  | { kind: 'MONEY'; amount: string; currency: string }
  | { kind: 'COUNT'; value: number }
  | { kind: 'PERCENT'; value: number }
  | { kind: 'DECIMAL'; value: number; precision?: number };

export interface Change {
  basis: 'LAST_YEAR';
  direction: TrendDirection;
  sentiment: Sentiment;
  pct?: number;
  pp?: number;
  abs?: MetricScalar;
}
export interface GoalProgress { state: 'SET' | 'NOT_SET'; target?: MetricScalar; progressPct?: number }
export interface PeriodWindow { type: PeriodType; startDate: string; endDate: string }
export interface SnapshotContext {
  period: PeriodWindow; businessLine: BusinessLine; basis: Basis;
  scope: Scope; teamView?: TeamView; asOfDate: string;
}
export interface MetricSnapshot {
  metricCode: string; valueType: ScalarKind; variant?: Variant;
  collected: MetricScalar; penders?: MetricScalar;
  subMeasures?: Array<{ measureCode: string; value: MetricScalar }>;
  goal: GoalProgress; comparison?: Change; asOfDate: string;
}
export interface MetricSnapshotList { context: SnapshotContext; items: MetricSnapshot[] }

export interface VariantValue { variant: Variant; collected: MetricScalar; penders?: MetricScalar }
export interface Threshold { value: number; comparator: 'GTE' | 'LTE' }
export interface BreakdownTable {
  variant: Variant; columns: BusinessLine[];
  rows: Array<{ productCode: string; weightPct?: number; cells: Array<{ businessLine: BusinessLine; value: MetricScalar }> }>;
  totals: Array<{ businessLine: BusinessLine; value: MetricScalar }>;
}
export interface BarComparison {
  years: number[];
  axis?: { unitCode?: string };
  measures: Array<{ measureCode?: string; points: Array<{ year: number; value: MetricScalar; change?: Change }> }>;
}
export interface MetricDetail {
  metricCode: string; valueType: ScalarKind; context: SnapshotContext;
  dataState: 'OK' | 'PROCESSING' | 'EMPTY';
  notices?: Array<{ code: string; severity: 'INFO' | 'WARNING'; params?: Record<string, string> }>;
  primary?: VariantValue; altVariants?: VariantValue[];
  comparison?: { current: MetricScalar; prior: MetricScalar; priorYear: number; change: Change };
  threshold?: Threshold; breakdowns?: BreakdownTable[]; barComparison?: BarComparison;
}
export interface SeriesPoint { month: number; value: MetricScalar | null }
export interface YearSeries { year: number; points: SeriesPoint[] }
export interface MetricSeries {
  metricCode: string; valueType: ScalarKind;
  context: { businessLine: BusinessLine; basis: Basis; scope: Scope; teamView?: TeamView; asOfDate: string };
  anchorYear: number; series: YearSeries[];
}
export interface TierRef { code: string; achievedAt?: string }
export interface MilestoneProgress {
  programCode: string; variant: Variant; cycleYear: number;
  currentTier: TierRef; nextTier?: TierRef; progressPct: number;
  measures: Array<{ measureCode: string; achieved: MetricScalar; target: MetricScalar }>;
}
export interface MilestoneProgressList { asOfDate: string; items: MilestoneProgress[] }

export interface MetricCapabilities {
  goal: boolean; penders: boolean; repricing: boolean; breakdown: boolean;
  threshold: boolean; history: boolean; barComparison?: boolean; memberTable?: boolean;
}
export interface SegmentOverride { included?: boolean; category?: 'PRIORITY' | 'FOCUS'; defaultSelected?: boolean; defaultOrder?: number }
export interface MetricDefinition {
  metricCode: string; valueType: ScalarKind; currency?: string;
  category: 'PRIORITY' | 'FOCUS'; defaultSelected: boolean; defaultOrder: number; customizable: boolean;
  scopes: Scope[];
  scopeOverrides?: Partial<Record<Scope, { category?: 'PRIORITY' | 'FOCUS'; defaultSelected?: boolean; defaultOrder?: number }>>;
  segmentOverrides?: Partial<Record<Basis, SegmentOverride>>;
  favourability: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  changeDisplay: 'PCT' | 'PP' | 'ABS';
  capabilities: MetricCapabilities;
  dimensions: { periods: PeriodType[]; businessLines: BusinessLine[]; basis: Basis[] };
  threshold?: Threshold;
}
export interface MetricPreferences {
  priorityMetricCodes: string[]; focusMetricCodes: string[];
  source: 'DEFAULT' | 'AGENT'; updatedAt: string | null;
}
export interface Problem { type?: string; title: string; status: number; code: string; detail?: string }
