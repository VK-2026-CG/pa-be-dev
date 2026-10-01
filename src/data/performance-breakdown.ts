import type { Document } from 'mongodb';
import { addDec, fromCents, mulRatio, toCents } from '../lib/money.js';
import { PERFORMANCE_BREAKDOWN_MAPPING, PERFORMANCE_PRODUCT_LEAVES, performanceProductPath } from './performance-mapping.js';
import { sourceMetricScalar } from './performance-values.js';
import type { BreakdownTable, BusinessLine, MetricScalar, PeriodType, Variant } from '../types.js';

type Money = Extract<MetricScalar, { kind: 'MONEY' }>;
type BreakdownRow = BreakdownTable['rows'][number];

/** PSA and Single Premium are labelled "(10%)" on the screen (Figma 1:16115); Credit Points carries no suffix. */
const WEIGHTED_PRODUCTS = new Set(['PSA', 'SINGLE_PREMIUM']);

const at = (row: Document | undefined, path: string): unknown =>
  path.split('.').reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Document)[key] : undefined), row);

/**
 * Credit Points for one variant and period (S-P4-02 AC-P4-02-33, mongodb.md D-19):
 * `B = 10% × (PSA + Single Premium)`, capped at `25% × A` where `A` is the sum of the product rows.
 * Checked against `snapshot.tpc.withoutRepricing.creditPoint` on the development cluster (Group row, MTD):
 * PSA 12,636.00 + SP 7,200.00 → 1,983.60, equal to the stored snapshot value. Computed from the period's own
 * product leaves, so MTD/QTD/YTD each get their own value; the single snapshot value is never copied into a period.
 */
export function creditPointAmount(psa: string, singlePremium: string, productTotal: string): string {
  const weighted = mulRatio(addDec(psa, singlePremium), 1, 10);
  const cap = mulRatio(productTotal, 1, 4);
  return toCents(weighted) < toCents(cap) ? weighted : cap;
}

/**
 * One breakdown table from the product leaves of a `my_production` row. A leaf that is null/invalid is
 * absent, never zero (source-mapping.md §2.4); a real 0 is kept. Returns undefined when no leaf is usable.
 * Totals are not stored upstream: they are the exact sum of the rows shown (Credit Points included).
 */
export function productBreakdown(
  row: Document | undefined, base: string, period: PeriodType, variant: Variant, businessLine: BusinessLine, withCreditPoints: boolean,
): BreakdownTable | undefined {
  const moneyOf = (leaf: string): Money | undefined => {
    const value = sourceMetricScalar('MONEY', at(row, performanceProductPath(base, leaf, period)));
    return value?.kind === 'MONEY' ? value : undefined;
  };
  const available = PERFORMANCE_PRODUCT_LEAVES.flatMap(({ leaf, productCode }) => {
    const value = moneyOf(leaf);
    return value ? [{ leaf, productCode, value }] : [];
  });
  if (!available.length) return undefined;

  const rows: BreakdownRow[] = available.map(({ productCode, value }) => ({
    productCode,
    ...(WEIGHTED_PRODUCTS.has(productCode) ? { weightPct: 10 } : {}),
    cells: [{ businessLine, value }],
  }));

  // Credit Points needs both weighted leaves; with either missing it stays unavailable rather than guessed.
  const psa = available.find((a) => a.leaf === 'psa')?.value.amount;
  const sp = available.find((a) => a.leaf === 'sp')?.value.amount;
  const productTotal = available.reduce((sum, a) => addDec(sum, a.value.amount), '0.00');
  if (withCreditPoints && psa !== undefined && sp !== undefined) {
    rows.push({
      productCode: 'CREDIT_POINTS',
      cells: [{ businessLine, value: { kind: 'MONEY', amount: creditPointAmount(psa, sp, productTotal), currency: 'MYR' } }],
    });
  }

  const total = rows.reduce((sum, r) => {
    const cell = r.cells[0]?.value;
    return cell?.kind === 'MONEY' ? sum + toCents(cell.amount) : sum;
  }, 0n);
  return { variant, columns: [businessLine], rows, totals: [{ businessLine, value: { kind: 'MONEY', amount: fromCents(total), currency: 'MYR' } }] };
}

/** Every breakdown table the metric supports for the period (TPC/PTPC: both variants; FYP: one), in display order. */
export function metricBreakdowns(metricCode: string, row: Document | undefined, period: PeriodType, businessLine: BusinessLine): BreakdownTable[] {
  const mapping = PERFORMANCE_BREAKDOWN_MAPPING[metricCode];
  if (!mapping) return [];
  return (['WITHOUT_REPRICING', 'WITH_REPRICING'] as const).flatMap((variant) => {
    const base = mapping.variants[variant];
    const table = base ? productBreakdown(row, base, period, variant, businessLine, mapping.creditPoints) : undefined;
    return table ? [table] : [];
  });
}
