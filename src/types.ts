/** Domain types mirroring vendor/spec/insights.v1.yaml (v1.4.0). Field names are the contract — do not rename. */
export type PeriodType = 'MTD' | 'QTD' | 'YTD';
export type BusinessLine = 'ALL' | 'INSURANCE' | 'TAKAFUL';
export type Basis = 'STANDARD' | 'SCHEME';
export type Scope = 'SELF' | 'TEAM';
export type TeamView = 'DIRECT' | 'GROUP';
/** Team Drilldown hierarchy axis (S-P4-07), distinct from performance `Basis`. */
export type DrilldownBasis = 'AGENT' | 'AM' | 'UM';
export type Variant = 'WITHOUT_REPRICING' | 'WITH_REPRICING';
export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
export type TrendDirection = 'UP' | 'DOWN' | 'FLAT';
export type ScalarKind = 'MONEY' | 'COUNT' | 'PERCENT' | 'DECIMAL';
/**
 * Read-time data state (insights.v1 `dataState`, mongodb.md §7.7 / §7.13).
 * OK ⇒ a value is present. PROCESSING ⇒ tenant batch in flight. EMPTY ⇒ no
 * approved upstream source, or batch complete with no data. Never zero-filled.
 */
export type DataState = 'OK' | 'PROCESSING' | 'EMPTY';
/** Data-gap banner shared by metric detail and dashboard cards (OpenAPI `Notice`). */
export interface Notice { code: string; severity: 'INFO' | 'WARNING'; params?: Record<string, string> }

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
  /**
   * v1.4.0: `collected` and `goal` left `required` in insights.v1.yaml — they are
   * present only when `dataState = OK`. A non-OK item keeps `metricCode`/`valueType`
   * so the dashboard renders a card state instead of dropping the metric (§7.13).
   * `dataState` absent ⇒ OK (back-compat default).
   */
  dataState?: DataState; notices?: Notice[];
  collected?: MetricScalar; penders?: MetricScalar;
  subMeasures?: Array<{ measureCode: string; value: MetricScalar }>;
  goal?: GoalProgress; comparison?: Change; asOfDate: string;
}
export interface MetricSnapshotList { context: SnapshotContext; items: MetricSnapshot[] }

export interface TeamMember {
  agentId: string;
  displayName: string;
  hierarchyBasis: DrilldownBasis;
  roleCode: string;
}

export interface TeamMemberList {
  asOfDate: string;
  items: TeamMember[];
}

export interface TeamMemberDashboard {
  member: TeamMember;
  context: SnapshotContext;
  metrics: MetricSnapshot[];
}

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
  dataState: DataState;
  notices?: Notice[];
  primary?: VariantValue; altVariants?: VariantValue[];
  comparison?: { current: MetricScalar; prior: MetricScalar; priorYear: number; change: Change };
  threshold?: Threshold; breakdowns?: BreakdownTable[]; barComparison?: BarComparison;
  /** v1.7.0 (AC-P4-02-32): TEAM-scope Penders case count for TPC/PTPC — COUNT, distinct from `primary.penders` (MONEY). Absent at scope=SELF. */
  pendersCaseCount?: number;
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
/**
 * Source availability (mongodb.md §4.1, v1.4.0) — independent of `capabilities`:
 * capabilities say what a metric *may* express, availability says whether an
 * approved upstream source can populate it. `UNBACKED` metrics must surface via
 * `dataState`, never as a synthesized or zero-filled value. Authoritative
 * readiness lives in source-mapping.md §6.
 */
export type Availability = 'BACKED' | 'UNBACKED' | 'CANDIDATE';
export interface MetricDefinition {
  metricCode: string; valueType: ScalarKind; currency?: string;
  availability?: Availability;
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
