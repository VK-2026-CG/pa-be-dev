import { describe, expect, it } from 'vitest';
import { pctRoundUp } from '../src/data/values.js';
import { pctRoundUpDec } from '../src/lib/money.js';

// widget-contracts §2 R-PCT-ROUNDUP — S-P4-02 v1.13.0 (ARVIJ-159).
describe('R-PCT-ROUNDUP (AC-P4-02-45)', () => {
  it('rounds away from zero: +23.4 ⇒ 24, −23.4 ⇒ −24', () => {
    expect(pctRoundUp(234, 1000)).toBe(24);
    expect(pctRoundUp(-234, 1000)).toBe(-24);
  });

  it("matches the story's AC8 example: 120 vs 110 (+9.09%) ⇒ +10", () => {
    expect(pctRoundUp(120 - 110, 110)).toBe(10);
  });

  it('keeps exact integers exact (no float creep to the next step)', () => {
    expect(pctRoundUp(10, 100)).toBe(10);
    expect(pctRoundUp(7, 700)).toBe(1);
    expect(pctRoundUp(3, 10)).toBe(30); // 0.3 * 100 floats to 30.000000000000004
  });

  it('any non-zero change is at least ±1; only an exact zero gives 0', () => {
    expect(pctRoundUp(1, 500)).toBe(1);
    expect(pctRoundUp(-1, 500)).toBe(-1);
    expect(pctRoundUp(0, 18)).toBe(0);
  });

  it('canonical fixture: 25 vs 18 (+38.9%) ⇒ 39', () => {
    expect(pctRoundUp(25 - 18, 18)).toBe(39);
  });
});

// S-P4-02 v1.14.0 (ARVIJ-160): ACTIVITY_RATIO opts in, on decimal ratios scaled to integers.
describe('R-PCT-ROUNDUP for ACTIVITY_RATIO (AC-P4-02-49)', () => {
  it('canonical fixture: 72.4 vs 61.8 (+17.15%) ⇒ 18, not the 10.6pp difference', () => {
    expect(pctRoundUp(724 - 618, 618)).toBe(18);
  });
  it('stub values: 95 vs 93 (+2.15%) ⇒ 3', () => {
    expect(pctRoundUp(95 - 93, 93)).toBe(3);
  });
});

// S-P4-02 v1.15.0 (ARVIJ-161): PRODUCTIVITY opts in, on DECIMAL values scaled to integers.
describe('R-PCT-ROUNDUP for PRODUCTIVITY (AC-P4-02-51)', () => {
  it('canonical fixture: 9.7 vs 9.3 (+4.30%) ⇒ 5, not the +0.4 difference', () => {
    expect(pctRoundUp(97 - 93, 93)).toBe(5);
  });
  it('a decline rounds away from zero: 9.3 vs 9.7 (−4.12%) ⇒ −5', () => {
    expect(pctRoundUp(93 - 97, 97)).toBe(-5);
  });
});

// S-P4-02 v1.16.0 (ARVIJ-162): AVERAGE_CASE_SIZE opts in, on exact decimal-string MONEY amounts.
describe('R-PCT-ROUNDUP for AVERAGE_CASE_SIZE (AC-P4-02-53)', () => {
  it('canonical fixture: RM 5,200.00 vs RM 4,800.00 (+8.33%) ⇒ 9, not +RM 400 (AC-P4-02-52)', () => {
    expect(pctRoundUpDec('5200.00', '4800.00')).toBe(9);
  });
  it('a decline rounds away from zero: RM 4,800.00 vs RM 5,200.00 (−7.69%) ⇒ −8', () => {
    expect(pctRoundUpDec('4800.00', '5200.00')).toBe(-8);
  });
  it('exact integers stay exact and a one-cent change is at least ±1', () => {
    expect(pctRoundUpDec('100000.00', '80000.00')).toBe(25);
    expect(pctRoundUpDec('4800.01', '4800.00')).toBe(1);
    expect(pctRoundUpDec('4800.00', '4800.00')).toBe(0);
  });
  it('stays exact beyond float precision (15-digit amounts)', () => {
    expect(pctRoundUpDec('999999999999999.99', '999999999999999.98')).toBe(1);
  });
});
