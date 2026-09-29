/**
 * Deterministic stub value engine. Base numbers come from the P4/P2-P3 mocks
 * (spec repo screens/*). Dimension multipliers are rationals so money stays
 * exact (cents math), and every (period × businessLine × scope × teamView ×
 * basis) combination yields stable, visibly different values.
 */
import { addDec, mulRatio, toCents } from '../lib/money.js';
import { effectiveCatalog, findDef } from './catalog.js';
import { changeFor, directionFor, roundToOneDecimal, sentimentFor } from './change.js';
import { mockTeamPendersCaseCount } from './mocks/team-penders.js';
import type {
  BarComparison, Basis, BreakdownTable, BusinessLine, Change, GoalProgress,
  MetricDetail, MetricScalar, MetricSeries, MetricSnapshot, MetricSnapshotList,
  MilestoneProgressList, PeriodType, ScalarKind, Scope, SnapshotContext, TeamView,
} from '../types.js';

export const AS_OF_DATE = '2026-07-27';
export const ANCHOR_YEAR = 2026;

export interface Lens {
  period: PeriodType; businessLine: BusinessLine; basis: Basis;
  scope: Scope; teamView?: TeamView;
}

type Ratio = [num: number, den: number];
const PERIOD_R: Record<PeriodType, Ratio> = { YTD: [1, 1], QTD: [3, 5], MTD: [11, 50] };
const BL_R: Record<BusinessLine, Ratio> = { ALL: [1, 1], INSURANCE: [4, 5], TAKAFUL: [1, 5] };
const SCOPE_R: Record<Scope, Ratio> = { SELF: [1, 1], TEAM: [3, 1] };
const TV_R: Record<TeamView, Ratio> = { DIRECT: [1, 1], GROUP: [11, 5] };
const BASIS_R: Record<Basis, Ratio> = { STANDARD: [1, 1], SCHEME: [1, 2] };

function ratios(l: Lens): Ratio[] {
  const r: Ratio[] = [PERIOD_R[l.period], BL_R[l.businessLine], SCOPE_R[l.scope], BASIS_R[l.basis]];
  if (l.scope === 'TEAM') r.push(TV_R[l.teamView ?? 'DIRECT']);
  return r;
}
function scaleDec(base: string, l: Lens): string {
  return ratios(l).reduce((acc, [n, d]) => mulRatio(acc, n, d), base);
}
function scaleInt(base: number, l: Lens): number {
  const [n, d] = ratios(l).reduce<Ratio>(([an, ad], [bn, bd]) => [an * bn, ad * bd], [1, 1]);
  return Math.max(0, Math.round((base * n) / d));
}

/** Base YTD/ALL/SELF/STANDARD figures per metric (mock-sourced). */
const MONEY_BASE: Record<string, { collected: string; prior: string; penders: string }> = {
  TPC: { collected: '100000.00', prior: '78740.00', penders: '30000.00' },
  PTPC: { collected: '70000.00', prior: '95890.00', penders: '21000.00' },
  FYP: { collected: '360000.00', prior: '283460.00', penders: '54000.00' },
  FYC: { collected: '180000.00', prior: '141730.00', penders: '30000.00' },
  AVERAGE_CASE_SIZE: { collected: '100000.00', prior: '80000.00', penders: '0.00' },
};
const COUNT_BASE: Record<string, { collected: number; prior: number; penders: number }> = {
  CASE_COUNT: { collected: 12, prior: 13, penders: 4 },
  NEW_RECRUIT_CONTRACTED: { collected: 22, prior: 15, penders: 0 },
  MANPOWER: { collected: 25, prior: 18, penders: 0 }, // closing manpower
};
const PERCENT_BASE: Record<string, { current: number; prior: number }> = {
  PERSISTENCY_CY: { current: 95, prior: 93 },
  PERSISTENCY_Y1: { current: 95, prior: 93 },
  PERSISTENCY_Y2: { current: 82, prior: 84 },
  ACTIVITY_RATIO: { current: 95, prior: 93 },
};
const DECIMAL_BASE: Record<string, { current: number; prior: number }> = {
  PRODUCTIVITY: { current: 9.7, prior: 9.3 },
};

function scalar(kind: ScalarKind, moneyAmount: string | null, num: number | null): MetricScalar {
  if (kind === 'MONEY') return { kind, amount: moneyAmount ?? '0.00', currency: 'MYR' };
  if (kind === 'COUNT') return { kind, value: num ?? 0 };
  if (kind === 'PERCENT') return { kind, value: num ?? 0 };
  return { kind: 'DECIMAL', value: num ?? 0, precision: 1 };
}

interface Pair { current: MetricScalar; prior: MetricScalar; change: Change }
function valuePair(code: string, l: Lens): Pair {
  const def = findDef(code);
  const kind = def?.valueType ?? 'MONEY';
  let current: MetricScalar; let prior: MetricScalar;
  if (kind === 'MONEY') {
    const b = MONEY_BASE[code] ?? MONEY_BASE.TPC!;
    current = scalar('MONEY', scaleDec(b.collected, l), null);
    prior = scalar('MONEY', scaleDec(b.prior, l), null);
  } else if (kind === 'COUNT') {
    const b = COUNT_BASE[code] ?? COUNT_BASE.CASE_COUNT!;
    current = scalar('COUNT', null, scaleInt(b.collected, l));
    prior = scalar('COUNT', null, scaleInt(b.prior, l));
  } else if (kind === 'PERCENT') {
    const b = PERCENT_BASE[code] ?? PERCENT_BASE.PERSISTENCY_CY!;
    current = scalar('PERCENT', null, b.current);
    prior = scalar('PERCENT', null, b.prior);
  } else {
    const b = DECIMAL_BASE[code] ?? DECIMAL_BASE.PRODUCTIVITY!;
    current = scalar('DECIMAL', null, b.current);
    prior = scalar('DECIMAL', null, b.prior);
  }
  return { current, prior, change: changeFor(code, current, prior) };
}

function pendersFor(code: string, l: Lens): MetricScalar | undefined {
  const def = findDef(code);
  if (!def?.capabilities.penders) return undefined;
  // v1.10.0 (AC-P4-02-37, ARVIJ-20): CASE_COUNT SELF gets no Penders exposure at
  // all — not in the gauge legend, not as its own KPI card (that section is
  // itself built from this same value for COUNT-primary metrics) — narrower
  // than TPC/PTPC SELF, which keeps a MONEY figure in the gauge legend.
  if (code === 'CASE_COUNT' && l.scope === 'SELF') return undefined;
  if (def.valueType === 'MONEY') {
    const b = MONEY_BASE[code] ?? MONEY_BASE.TPC!;
    return scalar('MONEY', scaleDec(b.penders, l), null);
  }
  const b = COUNT_BASE[code] ?? COUNT_BASE.CASE_COUNT!;
  return scalar('COUNT', null, scaleInt(b.penders, l));
}

/**
 * v1.7.0 (ARVIJ-157 AC-P4-02-32): TEAM-scope Penders case count for
 * MONEY-primary metrics with repricing (TPC/PTPC) — a case count, distinct
 * from and never derived from `pendersFor`'s MONEY value above. Sourced from
 * the interim mock in `./mocks/team-penders.ts` until the real figure is
 * wired up — that's an upstream API call, not a Mongo collection, and is
 * blocked on business confirming the call contract (endpoint/auth/shape
 * still unconfirmed as of this writing) (mongodb.md v1.7.0 D-19); SELF never
 * gets this — Self's Penders stays the money amount inside the gauge legend
 * (AC-P4-02-31).
 */
function teamPendersCaseCountFor(code: string, l: Lens): number | undefined {
  if (l.scope !== 'TEAM') return undefined;
  const def = findDef(code);
  if (!def?.capabilities.repricing) return undefined;
  return mockTeamPendersCaseCount(code, l.teamView ?? 'DIRECT');
}

/** Scheme agents "have different goals" (D-13): goals are SET under SCHEME, NOT_SET under STANDARD (Set Goals flow pending — roadmap §7b). */
function goalFor(code: string, l: Lens, current: MetricScalar): GoalProgress {
  const def = findDef(code);
  if (!def?.capabilities.goal) return { state: 'NOT_SET' };
  if (l.basis !== 'SCHEME') return { state: 'NOT_SET' };
  if (current.kind === 'MONEY') {
    const target = mulRatio(current.amount, 19, 20);
    const progressPct = Math.round((Number(toCents(current.amount)) / Number(toCents(target))) * 100);
    return { state: 'SET', target: { kind: 'MONEY', amount: target, currency: 'MYR' }, progressPct };
  }
  if (current.kind === 'COUNT') {
    const target = Math.max(1, Math.round(current.value * 1.2));
    return { state: 'SET', target: { kind: 'COUNT', value: target }, progressPct: Math.round((current.value / target) * 100) };
  }
  return { state: 'NOT_SET' };
}

function periodWindow(period: PeriodType): SnapshotContext['period'] {
  const start = period === 'YTD' ? '2026-01-01' : period === 'QTD' ? '2026-04-01' : '2026-07-01';
  return { type: period, startDate: start, endDate: AS_OF_DATE };
}
export function contextFor(l: Lens): SnapshotContext {
  return {
    period: periodWindow(l.period), businessLine: l.businessLine, basis: l.basis,
    scope: l.scope, ...(l.scope === 'TEAM' ? { teamView: l.teamView ?? 'DIRECT' } : {}),
    asOfDate: AS_OF_DATE,
  };
}

function snapshotFor(code: string, l: Lens): MetricSnapshot {
  const def = findDef(code)!;
  const pair = valuePair(code, l);
  const snap: MetricSnapshot = {
    metricCode: code, valueType: def.valueType,
    ...(def.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' as const } : {}),
    collected: pair.current,
    goal: goalFor(code, l, pair.current),
    comparison: pair.change,
    asOfDate: AS_OF_DATE,
  };
  const penders = pendersFor(code, l);
  if (penders) snap.penders = penders;
  if (code === 'MANPOWER') {
    snap.subMeasures = [
      { measureCode: 'OPENING', value: { kind: 'COUNT', value: scaleInt(10, l) } },
      { measureCode: 'CLOSING', value: pair.current },
    ];
  }
  return snap;
}

export function metricList(l: Lens, scopeFilter: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]): MetricSnapshotList {
  let defs = effectiveCatalog(l.scope, l.basis);
  if (scopeFilter !== 'ALL') defs = defs.filter((d) => d.effCategory === scopeFilter);
  if (codes?.length) defs = defs.filter((d) => codes.includes(d.metricCode));
  return { context: contextFor(l), items: defs.map((d) => snapshotFor(d.metricCode, l)) };
}

// v1.9.0 (ARVIJ-106/157 AC-P4-02-36): PTPC's product-category breakdown is the
// same 5-product set as TPC — UNIT_TRUST/GROUP_PREMIUM are not part of PTPC's
// definition. PRODUCT_BASE keeps their base amounts (spec keeps the codes
// documented as reserved/unused) but `breakdown()` below no longer reads them
// for either metric.
const PRODUCTS_TPC = ['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM'];
// v1.11.0 (ARVIJ-107/165 AC-P4-02-40): FYP reactivates the old 7-product set
// TPC/PTPC moved away from in v1.9.0 (UNIT_TRUST/GROUP_PREMIUM included), with
// CREDIT_POINTS as a plain weighted row in-list — not TPC/PTPC's separately
// appended, capped `creditPointCell()` row.
const PRODUCTS_FYP = ['LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS', 'UNIT_TRUST', 'GROUP_PREMIUM'];
const PRODUCT_BASE: Record<string, string> = {
  LINKED_PREMIUM: '12345.00', REGULAR_PREMIUM: '14000.00', PSA: '15007.00',
  SINGLE_PREMIUM: '20000.00', UNIT_TRUST: '10000.00', GROUP_PREMIUM: '10000.00',
  CREDIT_POINTS: '12000.00', // FYP only (plain row) -- TPC/PTPC compute CREDIT_POINTS via creditPointCell() instead
};
const WEIGHTED = new Set(['PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS']);

/**
 * v1.7.0 (ARVIJ-19/157 AC-P4-02-33, mongodb.md D-19): CREDIT_POINTS is now
 * pipeline-computed rather than a `PRODUCT_DATA_MISSING` placeholder, per
 * variant and per business-line column: A = Linked+Regular+PSA+Single for
 * that column (the "core" premium total); B = 10%×Single + 10%×PSA (same
 * column); Credit Point = B when B < 25%×A, else capped at 25%×A. Applies to
 * both scopes and both variants — confirmed with product for this revision.
 */
function creditPointCell(cellAmount: (productCode: string) => string): string {
  const a = addDec(
    addDec(cellAmount('LINKED_PREMIUM'), cellAmount('REGULAR_PREMIUM')),
    addDec(cellAmount('PSA'), cellAmount('SINGLE_PREMIUM')),
  );
  const b = addDec(mulRatio(cellAmount('SINGLE_PREMIUM'), 1, 10), mulRatio(cellAmount('PSA'), 1, 10));
  const cap = mulRatio(a, 1, 4);
  return toCents(b) < toCents(cap) ? b : cap;
}

/**
 * v1.8.0 (AC-P4-02-35): the breakdown table has exactly one column, equal to
 * the request's own `businessLine` — never a fixed [INSURANCE, TAKAFUL] pair.
 * `BL_R.ALL` is already the combined Insurance+Takaful ratio by construction
 * (`BL_R.INSURANCE` + `BL_R.TAKAFUL` sum to `BL_R.ALL`), so requesting the
 * `ALL` column directly yields the combined total — no separate summing step.
 */
function breakdown(code: string, variant: 'WITHOUT_REPRICING' | 'WITH_REPRICING', l: Lens): BreakdownTable {
  const def = findDef(code);
  // v1.11.0 (AC-P4-02-40): FYP uses the 7-product set (CREDIT_POINTS already
  // in-list, plain weighted); TPC/PTPC keep their narrowed 5-code set with
  // CREDIT_POINTS appended separately below via the capped formula.
  const products = code === 'FYP' ? PRODUCTS_FYP : PRODUCTS_TPC;
  const columns: BusinessLine[] = [l.businessLine];
  const varRatio: Ratio = variant === 'WITH_REPRICING' ? [6, 5] : [1, 1];
  const cellAmount = (productCode: string): string => mulRatio(scaleDec(PRODUCT_BASE[productCode]!, l), varRatio[0], varRatio[1]);
  const rows = products.map((productCode) => ({
    productCode,
    ...(WEIGHTED.has(productCode) ? { weightPct: 10 } : {}),
    cells: [{ businessLine: l.businessLine, value: { kind: 'MONEY', amount: cellAmount(productCode), currency: 'MYR' } as MetricScalar }],
  }));
  // v1.7.0 (AC-P4-02-33, mongodb.md D-19): only TPC/PTPC (repricing-capable)
  // get a separately appended, pipeline-computed capped CREDIT_POINTS row.
  // FYP's CREDIT_POINTS row already came from PRODUCTS_FYP above as a plain
  // weighted value -- must NOT also get this capped row (AC-P4-02-40).
  if (def?.capabilities.repricing) {
    rows.push({
      productCode: 'CREDIT_POINTS', weightPct: 10,
      cells: [{ businessLine: l.businessLine, value: { kind: 'MONEY', amount: creditPointCell(cellAmount), currency: 'MYR' } as MetricScalar }],
    });
  }
  const totals = [{
    businessLine: l.businessLine,
    value: {
      kind: 'MONEY' as const, currency: 'MYR',
      amount: rows.reduce((acc, r) => {
        const cell = r.cells[0]!;
        return cell.value.kind === 'MONEY' ? addDec(acc, cell.value.amount) : acc;
      }, '0.00'),
    },
  }];
  return { variant, columns, rows, totals };
}

function barComparisonFor(code: string, l: Lens): BarComparison {
  if (code === 'MANPOWER') {
    const mk = (base: number, prior: number, measureCode: string) => ({
      measureCode,
      points: [
        { year: ANCHOR_YEAR - 1, value: { kind: 'COUNT' as const, value: scaleInt(prior, l) } },
        {
          year: ANCHOR_YEAR, value: { kind: 'COUNT' as const, value: scaleInt(base, l) },
          change: {
            basis: 'LAST_YEAR' as const, direction: directionFor(scaleInt(base, l) - scaleInt(prior, l)),
            sentiment: sentimentFor(code, scaleInt(base, l) - scaleInt(prior, l)),
            abs: { kind: 'COUNT' as const, value: scaleInt(base, l) - scaleInt(prior, l) },
          },
        },
      ],
    });
    return {
      years: [ANCHOR_YEAR - 1, ANCHOR_YEAR],
      axis: { unitCode: 'AGENTS' },
      measures: [mk(10, 7, 'OPENING'), mk(25, 18, 'CLOSING')],
    };
  }
  const b = COUNT_BASE[code] ?? COUNT_BASE.NEW_RECRUIT_CONTRACTED!;
  const cur = scaleInt(b.collected, l); const pri = scaleInt(b.prior, l);
  return {
    years: [ANCHOR_YEAR - 1, ANCHOR_YEAR],
    measures: [{
      points: [
        { year: ANCHOR_YEAR - 1, value: { kind: 'COUNT', value: pri } },
        {
          year: ANCHOR_YEAR, value: { kind: 'COUNT', value: cur },
          change: {
            basis: 'LAST_YEAR', direction: directionFor(cur - pri),
            sentiment: sentimentFor(code, cur - pri), abs: { kind: 'COUNT', value: cur - pri },
          },
        },
      ],
    }],
  };
}

export function metricDetail(code: string, l: Lens, demoState?: 'EMPTY' | 'PROCESSING'): MetricDetail | undefined {
  const def = effectiveCatalog(l.scope, l.basis).find((d) => d.metricCode === code);
  if (!def) return undefined;
  const base: MetricDetail = {
    metricCode: code, valueType: def.valueType, context: contextFor(l), dataState: 'OK',
  };
  if (demoState) return { ...base, dataState: demoState };

  const pair = valuePair(code, l);
  base.primary = {
    variant: 'WITHOUT_REPRICING',
    collected: pair.current,
    ...(pendersFor(code, l) ? { penders: pendersFor(code, l)! } : {}),
  };
  base.comparison = { current: pair.current, prior: pair.prior, priorYear: ANCHOR_YEAR - 1, change: pair.change };
  if (def.capabilities.repricing && pair.current.kind === 'MONEY') {
    base.altVariants = [{
      variant: 'WITH_REPRICING',
      collected: { kind: 'MONEY', amount: mulRatio(pair.current.amount, 6, 5), currency: 'MYR' },
    }];
  }
  if (def.capabilities.threshold && def.threshold) base.threshold = def.threshold;
  if (def.capabilities.breakdown) {
    // v1.7.0 (AC-P4-02-33): CREDIT_POINTS is now pipeline-computed — no more PRODUCT_DATA_MISSING notice for it.
    // v1.11.0 (AC-P4-02-40): FYP has no repricing capability, so it never emits
    // a WITH_REPRICING breakdown variant -- only metrics with repricing (TPC/PTPC) do.
    base.breakdowns = def.capabilities.repricing
      ? [breakdown(code, 'WITHOUT_REPRICING', l), breakdown(code, 'WITH_REPRICING', l)]
      : [breakdown(code, 'WITHOUT_REPRICING', l)];
  }
  if (def.capabilities.barComparison) base.barComparison = barComparisonFor(code, l);
  const pendersCaseCount = teamPendersCaseCountFor(code, l);
  if (pendersCaseCount !== undefined) base.pendersCaseCount = pendersCaseCount;
  return base;
}

/** Monthly weights (per-mille of the YTD total across closed months Jan–Jul). */
const MONTH_W = [186, 117, 111, 169, 169, 111, 81, 0, 0, 0, 0, 0] as const;
const CLOSED_MONTHS = 7;

export function metricSeries(code: string, l: Lens, anchorYear: number, yearsBack: number): MetricSeries | undefined {
  const def = effectiveCatalog(l.scope, l.basis).find((d) => d.metricCode === code);
  if (!def?.capabilities.history) return undefined;
  const years = Array.from({ length: yearsBack + 1 }, (_, i) => anchorYear - i);
  const ytd: Lens = { ...l, period: 'YTD' };
  const series = years.map((year) => {
    const yearRatio: Ratio = year === ANCHOR_YEAR ? [1, 1] : year === ANCHOR_YEAR - 1 ? [4, 5] : [7, 10];
    const points = MONTH_W.map((w, mi) => {
      const month = mi + 1;
      const open = year === ANCHOR_YEAR && month > CLOSED_MONTHS;
      if (open) return { month, value: null };
      const weight: Ratio = year === ANCHOR_YEAR ? [w, 1000] : [83, 1000];
      let value: MetricScalar;
      if (def.valueType === 'MONEY') {
        const b = MONEY_BASE[code] ?? MONEY_BASE.TPC!;
        let amt = scaleDec(b.collected, ytd);
        amt = mulRatio(amt, yearRatio[0], yearRatio[1]);
        amt = mulRatio(amt, weight[0], weight[1]);
        value = { kind: 'MONEY', amount: amt, currency: 'MYR' };
      } else if (def.valueType === 'COUNT') {
        const b = COUNT_BASE[code] ?? COUNT_BASE.CASE_COUNT!;
        const base = scaleInt(b.collected, ytd) * yearRatio[0] / yearRatio[1];
        value = { kind: 'COUNT', value: Math.max(0, Math.round((base * weight[0]) / weight[1])) };
      } else if (def.valueType === 'PERCENT') {
        const b = PERCENT_BASE[code] ?? PERCENT_BASE.PERSISTENCY_CY!;
        const drift = [1, 0.5, 1.07, -0.93, -0.93, -0.89, 0][mi] ?? 0;
        const yearOff = year === ANCHOR_YEAR ? 0 : -0.5;
        value = { kind: 'PERCENT', value: roundToOneDecimal(b.current + drift + yearOff - 1) };
      } else {
        const b = DECIMAL_BASE[code] ?? DECIMAL_BASE.PRODUCTIVITY!;
        value = { kind: 'DECIMAL', value: roundToOneDecimal(b.current - (ANCHOR_YEAR - year) * 0.4 + mi * 0.02), precision: 1 };
      }
      return { month, value };
    });
    return { year, points };
  });
  return {
    metricCode: code, valueType: def.valueType,
    context: {
      businessLine: l.businessLine, basis: l.basis, scope: l.scope,
      ...(l.scope === 'TEAM' ? { teamView: l.teamView ?? 'DIRECT' } : {}), asOfDate: AS_OF_DATE,
    },
    anchorYear, series,
  };
}

export function milestones(): MilestoneProgressList {
  const money = (amount: string): MetricScalar => ({ kind: 'MONEY', amount, currency: 'MYR' });
  const measures = [
    { measureCode: 'FYP', achieved: money('600000.00'), target: money('798400.00') },
    { measureCode: 'FYC', achieved: money('200000.00'), target: money('332800.00') },
    { measureCode: 'ANNUAL_PREMIUM', achieved: money('200000.00'), target: money('332800.00') },
  ];
  const item = (programCode: string) => ({
    programCode, variant: 'WITHOUT_REPRICING' as const, cycleYear: ANCHOR_YEAR,
    currentTier: { code: 'MDRT' }, nextTier: { code: 'COT' }, progressPct: 60, measures,
  });
  return { asOfDate: AS_OF_DATE, items: [item('MDRT_SERIES'), item('STAR_CLUB')] };
}
