import { describe, it, expect } from 'vitest';
import { buildMomDeltas, splitTabs } from '../src/bff/compose/history.js';
import type { MetricScalar } from '../vendor/spec/performance-vm.js';

const money = (amount: string): MetricScalar => ({ kind: 'MONEY', amount, currency: 'MYR' });
const HIGHER = { favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT', valueType: 'MONEY' } as const;

describe('MoM builder (D-11, AC-P4-03-09/10/13)', () => {
  it('Jan and null-adjacent months are null; zero renders as a chip (NEUTRAL), not null', () => {
    const pts = [money('25246.00'), money('15876.00'), money('15876.00'), null, money('10000.00')];
    const d = buildMomDeltas(pts, HIGHER);
    expect(d[0]).toBeNull();                        // Jan
    expect(d[1]!.pct).toBe(-37.1);
    expect(d[1]!.sentiment).toBe('NEGATIVE');
    expect(d[2]!.pct).toBe(0);
    expect(d[2]!.sentiment).toBe('NEUTRAL');        // zero → chip, not N/A
    expect(d[3]).toBeNull();                        // own value null
    expect(d[4]).toBeNull();                        // previous null
  });
  it('unit follows the metric: PERCENT → pp; ABS COUNT → abs (+3)', () => {
    const pct = buildMomDeltas(
      [{ kind: 'PERCENT', value: 95 }, { kind: 'PERCENT', value: 94.5 }],
      { favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PP', valueType: 'PERCENT' },
    );
    expect(pct[1]).toMatchObject({ display: 'PP', pp: -0.5, sentiment: 'NEGATIVE' });
    const abs = buildMomDeltas(
      [{ kind: 'COUNT', value: 12 }, { kind: 'COUNT', value: 15 }],
      { favourability: 'HIGHER_IS_BETTER', changeDisplay: 'ABS', valueType: 'COUNT' },
    );
    expect(abs[1]).toMatchObject({ display: 'ABS', abs: { kind: 'COUNT', value: 3 } });
  });
  it('comparisonBasis is LAST_MONTH and sentiment respects favourability', () => {
    const d = buildMomDeltas([money('10.00'), money('12.00')], HIGHER);
    expect(d[1]).toMatchObject({ comparisonBasis: 'LAST_MONTH', direction: 'UP', sentiment: 'POSITIVE' });
  });
});

describe('history tab overflow (AC-P4-03-12)', () => {
  const nine = ['TPC', 'CASE_COUNT', 'FYP', 'FYC', 'MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE', 'NEW_RECRUIT_CONTRACTED'];
  it('selected overflow metric swaps into the visible set exactly once', () => {
    const { tabs, moreTabs } = splitTabs(nine, 'PRODUCTIVITY');
    expect(tabs.map((x) => x.metricCode)).toEqual(['TPC', 'CASE_COUNT', 'FYP', 'PRODUCTIVITY']);
    expect(tabs.find((x) => x.selected)!.metricCode).toBe('PRODUCTIVITY');
    expect(moreTabs.map((x) => x.metricCode)).toContain('FYC');
    expect(moreTabs.map((x) => x.metricCode)).not.toContain('PRODUCTIVITY');
  });
});
