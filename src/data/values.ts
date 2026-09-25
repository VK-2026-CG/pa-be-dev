/**
 * Deterministic stub value engine. Base numbers come from the P4/P2-P3 mocks
 * (spec repo screens/*). Dimension multipliers are rationals so money stays
 * exact (cents math), and every (period × businessLine × scope × teamView ×
 * basis) combination yields stable, visibly different values.
 */
import { addDec, mulRatio, pctChange, pctRoundUpDec, toCents } from '../lib/money.js';
import { effectiveCatalog, findDef } from './catalog.js';
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
  TPC: { collected: '980000.00', prior: '879712.75', penders: '30000.00' },
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

function round1(n: number): number { return Math.round(n * 10) / 10; }

function sentimentFor(code: string, delta: number): Change['sentiment'] {
  if (delta === 0) return 'NEUTRAL';
  const fav = findDef(code)?.favourability ?? 'HIGHER_IS_BETTER';
  const good = fav === 'HIGHER_IS_BETTER' ? delta > 0 : delta < 0;
  return good ? 'POSITIVE' : 'NEGATIVE';
}
function directionFor(delta: number): Change['direction'] {
  return delta === 0 ? 'FLAT' : delta > 0 ? 'UP' : 'DOWN';
}

function scalar(kind: ScalarKind, moneyAmount: string | null, num: number | null): MetricScalar {
  if (kind === 'MONEY') return { kind, amount: moneyAmount ?? '0.00', currency: 'MYR' };
  if (kind === 'COUNT') return { kind, value: num ?? 0 };
  if (kind === 'PERCENT') return { kind, value: num ?? 0 };
  return { kind: 'DECIMAL', value: num ?? 0, precision: 1 };
}

interface Pair { current: MetricScalar; prior: MetricScalar; change: Change }

/** Metrics opted into widget-contracts §2 `R-PCT-ROUNDUP` (S-P4-02 v1.13.0 AC-P4-02-45; v1.14.0 AC-P4-02-49; v1.15.0 AC-P4-02-51; v1.16.0 AC-P4-02-53). */
const PCT_ROUNDUP = new Set(['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE']);

/** Scale two decimals to integers on a common power of ten so `pctRoundUp` stays exact (72.4 vs 61.8 ⇒ 724 vs 618). */
function toScaledInts(a: number, b: number): [number, number] {
  const places = (n: number) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : Math.min(s.length - i - 1, 6); };
  const f = 10 ** Math.max(places(a), places(b));
  return [Math.round(a * f), Math.round(b * f)];
}

/**
 * `R-PCT-ROUNDUP`: integer % change rounded away from zero (+23.4 ⇒ 24, −23.4 ⇒ −24).
 * Integer arithmetic only, so an exact 10 never floats up to 11. `prior` must be non-zero
 * (zero prior is unresolved, OQ-54 — callers keep their existing behavior for it).
 */
export function pctRoundUp(diff: number, prior: number): number {
  const num = Math.abs(diff) * 100; const den = Math.abs(prior);
  const mag = Math.floor(num / den) + (num % den === 0 ? 0 : 1);
  return mag === 0 ? 0 : Math.sign(diff) * Math.sign(prior) * mag;
}

/** Year-over-year change between two same-kind scalars, per the metric's favourability (D-05) and changeDisplay (D-10). */
function changeFor(code: string, current: MetricScalar, prior: MetricScalar): Change {
  const display = findDef(code)?.changeDisplay ?? 'PCT';
  if (current.kind === 'MONEY' && prior.kind === 'MONEY') {
    // AVERAGE_CASE_SIZE (AC-P4-02-52/53): relative % of the exact amounts, rounded away from zero.
    const pct = PCT_ROUNDUP.has(code) ? pctRoundUpDec(current.amount, prior.amount) : pctChange(current.amount, prior.amount);
    return {
      basis: 'LAST_YEAR', direction: directionFor(pct), sentiment: sentimentFor(code, pct),
      ...(display === 'ABS'
        ? { abs: { kind: 'MONEY', amount: addDec(current.amount, mulRatio(prior.amount, -1, 1)), currency: 'MYR' } }
        : { pct }),
    };
  }
  if (current.kind === 'COUNT' && prior.kind === 'COUNT') {
    const diff = current.value - prior.value;
    const pct = prior.value === 0 ? 0
      : PCT_ROUNDUP.has(code) ? pctRoundUp(diff, prior.value)
        : Math.round((diff / prior.value) * 1000) / 10;
    return {
      basis: 'LAST_YEAR', direction: directionFor(diff), sentiment: sentimentFor(code, diff),
      ...(display === 'ABS' ? { abs: { kind: 'COUNT', value: diff } } : { pct }),
    };
  }
  if (current.kind === 'PERCENT' && prior.kind === 'PERCENT') {
    if (display === 'PCT' && PCT_ROUNDUP.has(code)) {
      // Relative % of the ratio, rounded away from zero from exact values (AC-P4-02-48/49).
      const [cur, pri] = toScaledInts(current.value, prior.value);
      const diff = cur - pri;
      const pct = pri === 0 ? 0 : pctRoundUp(diff, pri);
      return { basis: 'LAST_YEAR', direction: directionFor(diff), sentiment: sentimentFor(code, diff), pct };
    }
    const pp = round1(current.value - prior.value);
    const pct = prior.value === 0 ? 0 : round1(((current.value - prior.value) / prior.value) * 100);
    return {
      basis: 'LAST_YEAR', direction: directionFor(pp), sentiment: sentimentFor(code, pp),
      ...(display === 'PCT' ? { pct } : { pp }),
    };
  }
  if (current.kind === 'DECIMAL' && prior.kind === 'DECIMAL' && display === 'PCT') {
    // Relative % of the decimal value, not its absolute difference (AC-P4-02-50/51: 9.7 vs 9.3 ⇒ 5).
    const [cur, pri] = toScaledInts(current.value, prior.value);
    const diff = cur - pri;
    const pct = pri === 0 ? 0
      : PCT_ROUNDUP.has(code) ? pctRoundUp(diff, pri)
        : round1((diff / pri) * 100);
    return { basis: 'LAST_YEAR', direction: directionFor(diff), sentiment: sentimentFor(code, diff), pct };
  }
  const diff = round1((current as { value: number }).value - (prior as { value: number }).value);
  return {
    basis: 'LAST_YEAR', direction: directionFor(diff), sentiment: sentimentFor(code, diff),
    abs: { kind: 'DECIMAL', value: diff, precision: 1 },
  };
}

function valuePair(code: string, l: Lens): Pair {
  const kind = findDef(code)?.valueType ?? 'MONEY';
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
 * v1.7.0 (ARVIJ-157 AC-P4-02-32): Penders case count for MONEY-primary
 * metrics with repricing (TPC/PTPC) — a case count, distinct from and never
 * derived from `pendersFor`'s MONEY value above. Sourced from the interim mock
 * in `./mocks/team-penders.ts` until the pipeline materializes
 * `values.pendersCaseCount` in `metric_snapshots` (mongodb.md v1.7.0 D-19,
 * OQ-77). v1.20.0 (AC-P4-02-58): emitted at SELF too (the agent's own cases),
 * not only TEAM; CASE_COUNT's TEAM-only card comes from `pendersFor` instead.
 */
function pendersCaseCountFor(code: string, l: Lens): number | undefined {
  const def = findDef(code);
  if (!def?.capabilities.repricing) return undefined;
  return mockTeamPendersCaseCount(code, l.scope === 'TEAM' ? (l.teamView ?? 'DIRECT') : 'SELF');
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
    // v1.13.0 (AC-P4-02-42): Total Manpower = EXISTING_AGENTS + NEW_RECRUITS; `collected` is the total.
    const [existing, recruits] = manpowerSplit(pair.current, MANPOWER_NEW_RECRUITS.current, l);
    snap.subMeasures = [
      { measureCode: 'EXISTING_AGENTS', value: existing },
      { measureCode: 'NEW_RECRUITS', value: recruits },
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

/** Stub NEW_RECRUITS base (joined in the same calendar year) — MANPOWER totals stay COUNT_BASE. */
const MANPOWER_NEW_RECRUITS = { current: 8, prior: 4 } as const;

/**
 * STUB split of a Total Manpower count into [EXISTING_AGENTS, NEW_RECRUITS]. Real upstream has no
 * existing-agents field and total − newRecruits is NOT an approved source derivation (OQ-51); this
 * only keeps mock segments summing to the mock total.
 */
function manpowerSplit(total: MetricScalar, recruitsBase: number, l: Lens): [MetricScalar, MetricScalar] {
  const t = total.kind === 'COUNT' ? total.value : 0;
  const recruits = Math.min(t, scaleInt(recruitsBase, l));
  return [{ kind: 'COUNT', value: t - recruits }, { kind: 'COUNT', value: recruits }];
}

function barComparisonFor(code: string, l: Lens): BarComparison {
  if (code === 'MANPOWER') {
    // v1.13.0 (AC-P4-02-42/43): stacked EXISTING_AGENTS + NEW_RECRUITS; the only chip is on totals[].
    const pair = valuePair(code, l);
    const [curExisting, curRecruits] = manpowerSplit(pair.current, MANPOWER_NEW_RECRUITS.current, l);
    const [priExisting, priRecruits] = manpowerSplit(pair.prior, MANPOWER_NEW_RECRUITS.prior, l);
    const years = [ANCHOR_YEAR - 1, ANCHOR_YEAR];
    return {
      years,
      axis: { unitCode: 'AGENTS' },
      layout: 'STACKED',
      measures: [
        { measureCode: 'EXISTING_AGENTS', points: [{ year: years[0]!, value: priExisting }, { year: years[1]!, value: curExisting }] },
        { measureCode: 'NEW_RECRUITS', points: [{ year: years[0]!, value: priRecruits }, { year: years[1]!, value: curRecruits }] },
      ],
      totals: [
        { year: years[0]!, value: pair.prior },
        { year: years[1]!, value: pair.current, change: changeFor(code, pair.current, pair.prior) },
      ],
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

/**
 * v1.12.0 (AC-P4-02-46, ARVIJ-111/113/115/170/172/174): persistency drill-downs removed
 * the year-on-year comparison, so the detail omits `comparison` for these metrics (both
 * scopes). Detail only — dashboard snapshots keep their change for the S-P4-01 card.
 */
const NO_DETAIL_COMPARISON = new Set(['PERSISTENCY_CY', 'PERSISTENCY_Y1', 'PERSISTENCY_Y2']);

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
  if (!NO_DETAIL_COMPARISON.has(code)) {
    base.comparison = { current: pair.current, prior: pair.prior, priorYear: ANCHOR_YEAR - 1, change: pair.change };
  }
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
  const pendersCaseCount = pendersCaseCountFor(code, l);
  if (pendersCaseCount !== undefined) base.pendersCaseCount = pendersCaseCount;
  return base;
}

/** `value × num/den` for a same-kind stub ratio — money via cents math, counts rounded, rates unscaled. */
function scaleByRatio(value: MetricScalar, num: MetricScalar, den: MetricScalar): MetricScalar {
  if (value.kind === 'MONEY' && num.kind === 'MONEY' && den.kind === 'MONEY') {
    const d = Number(toCents(den.amount));
    return d === 0 ? num : { ...value, amount: mulRatio(value.amount, Number(toCents(num.amount)), d) };
  }
  if (value.kind === 'COUNT' && num.kind === 'COUNT' && den.kind === 'COUNT') {
    return den.value === 0 ? num : { kind: 'COUNT', value: Math.max(0, Math.round((value.value * num.value) / den.value)) };
  }
  return num; // PERCENT/DECIMAL are rates, not volumes — the stub prior is used as-is
}

/** Rescales a stub breakdown so its total equals `target`, then re-sums totals from the scaled rows. */
function scaleBreakdown(table: BreakdownTable, target: MetricScalar): BreakdownTable {
  const total = table.totals[0]?.value;
  if (!total || total.kind !== 'MONEY' || target.kind !== 'MONEY' || toCents(total.amount) === 0n) return table;
  const num = Number(toCents(target.amount)); const den = Number(toCents(total.amount));
  const rows = table.rows.map((r) => ({
    ...r,
    cells: r.cells.map((c) => (c.value.kind === 'MONEY' ? { ...c, value: { ...c.value, amount: mulRatio(c.value.amount, num, den) } } : c)),
  }));
  const totals = table.totals.map((t) => ({
    ...t,
    value: {
      kind: 'MONEY' as const, currency: 'MYR',
      amount: rows.reduce((acc, r) => {
        const cell = r.cells.find((c) => c.businessLine === t.businessLine);
        return cell?.value.kind === 'MONEY' ? addDec(acc, cell.value.amount) : acc;
      }, '0.00'),
    },
  }));
  return { ...table, rows, totals };
}

/**
 * DEV-ONLY (`INSIGHTS_DEV_MOCK_FALLBACK=true`, Performance source mode only —
 * see AGENTS.md "Dev mock fallback"): fills the parts of a Mongo-backed
 * detail the direct source cannot supply, from this stub engine. Real values
 * are never replaced. When Mongo has a Collected value, the mock prior year
 * and breakdown rows are rescaled to it so the combined card stays coherent
 * (the stub's growth % and product mix are kept). When Mongo has nothing,
 * the whole stub body is returned under the real context.
 */
export function mockFillDetail(code: string, l: Lens, real: MetricDetail): { detail: MetricDetail; filled: string[] } {
  const stub = metricDetail(code, l);
  if (!stub?.primary) return { detail: real, filled: [] };
  if (!real.primary) {
    const priorYear = Number((real.context.period.endDate ?? real.context.asOfDate).slice(0, 4)) - 1;
    return {
      detail: { ...stub, context: real.context, ...(stub.comparison ? { comparison: { ...stub.comparison, priorYear } } : {}) },
      filled: ['all'],
    };
  }
  const detail: MetricDetail = { ...real };
  const filled: string[] = [];
  const current = real.primary.collected;
  if (!detail.comparison && stub.comparison) {
    const prior = scaleByRatio(current, stub.comparison.prior, stub.comparison.current);
    const priorYear = Number((real.context.period.endDate ?? real.context.asOfDate).slice(0, 4)) - 1;
    detail.comparison = { current, prior, priorYear, change: changeFor(code, current, prior) };
    filled.push('comparison');
  }
  if (!detail.breakdowns && stub.breakdowns) {
    const realAlt = real.altVariants?.find((v) => v.variant === 'WITH_REPRICING')?.collected;
    const stubWithout = stub.breakdowns.find((b) => b.variant === 'WITHOUT_REPRICING');
    detail.breakdowns = stub.breakdowns.map((b) => {
      if (b.variant === 'WITHOUT_REPRICING') return scaleBreakdown(b, current);
      if (realAlt) return scaleBreakdown(b, realAlt);
      // No real repriced total: keep the stub's with/without proportion.
      const stubTotal = b.totals[0]?.value; const stubWithoutTotal = stubWithout?.totals[0]?.value;
      return stubTotal && stubWithoutTotal ? scaleBreakdown(b, scaleByRatio(current, stubTotal, stubWithoutTotal)) : b;
    });
    filled.push('breakdowns');
  }
  return { detail, filled };
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
        value = { kind: 'PERCENT', value: round1(b.current + drift + yearOff - 1) };
      } else {
        const b = DECIMAL_BASE[code] ?? DECIMAL_BASE.PRODUCTIVITY!;
        value = { kind: 'DECIMAL', value: round1(b.current - (ANCHOR_YEAR - year) * 0.4 + mi * 0.02), precision: 1 };
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
