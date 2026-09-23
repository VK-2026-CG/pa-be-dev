import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF metric detail (S-P4-02)', () => {
  it('TPC SELF: section order + 2 breakdowns, no Penders card, no CREDIT_POINTS notice (AC-P4-02-01/03/31/33)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC`);
    expect(d.sections.map((s: any) => s.type)).toEqual(
      ['GAUGE', 'COMPARISON', 'VARIANT_VALUE', 'BREAKDOWN', 'BREAKDOWN'],
    );
    expect(d.notices).toBeUndefined();
    const breakdown = d.sections.find((s: any) => s.type === 'BREAKDOWN');
    expect(breakdown.rows.map((r: any) => r.productCode)).toContain('CREDIT_POINTS');
    // v1.8.0 (AC-P4-02-35): single column, matching the (default ALL) businessLine.
    expect(breakdown.columns).toEqual(['ALL']);
  });

  it('TPC breakdown column follows the businessLine filter (AC-P4-02-35)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC?businessLine=INSURANCE`);
    const breakdown = d.sections.find((s: any) => s.type === 'BREAKDOWN');
    expect(breakdown.columns).toEqual(['INSURANCE']);
    expect(breakdown.rows[0].cells).toHaveLength(1);
  });

  it('PTPC breakdown matches TPC\'s 5-product set, no UNIT_TRUST/GROUP_PREMIUM (AC-P4-02-36)', async () => {
    const [ptpc, tpc] = await Promise.all([
      getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/PTPC`),
      getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC`),
    ]);
    const ptpcBreakdown = ptpc.sections.find((s: any) => s.type === 'BREAKDOWN');
    const tpcBreakdown = tpc.sections.find((s: any) => s.type === 'BREAKDOWN');
    const productCodes = ptpcBreakdown.rows.map((r: any) => r.productCode);
    expect(productCodes).toEqual(tpcBreakdown.rows.map((r: any) => r.productCode));
    expect(productCodes).not.toContain('UNIT_TRUST');
    expect(productCodes).not.toContain('GROUP_PREMIUM');
    expect(productCodes).toContain('CREDIT_POINTS');
    expect(productCodes).toHaveLength(5);
  });

  it('TPC TEAM: Penders card is a COUNT, sum-of-agents value, distinct from the gauge money penders (AC-P4-02-32)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/TPC?scope=TEAM`);
    expect(d.sections.map((s: any) => s.type)).toEqual(
      ['GAUGE', 'COMPARISON', 'VARIANT_VALUE', 'PENDERS', 'BREAKDOWN', 'BREAKDOWN'],
    );
    const penders = d.sections.find((s: any) => s.type === 'PENDERS');
    expect(penders.value.kind).toBe('COUNT');
  });

  it('CASE_COUNT SELF: no Penders anywhere — not the gauge legend, not its own card (AC-P4-02-37)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/CASE_COUNT`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON']);
    const gauge = d.sections.find((s: any) => s.type === 'GAUGE');
    expect(gauge.penders).toBeUndefined();
    expect(d.sections.find((s: any) => s.type === 'PENDERS')).toBeUndefined();
  });

  it('CASE_COUNT TEAM: gauge keeps the COUNT penders legend AND gets its own Penders KPI card (AC-P4-02-37)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/CASE_COUNT?scope=TEAM`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON', 'PENDERS']);
    const gauge = d.sections.find((s: any) => s.type === 'GAUGE');
    expect(gauge.penders.kind).toBe('COUNT');
    const penders = d.sections.find((s: any) => s.type === 'PENDERS');
    expect(penders.value.kind).toBe('COUNT');
    expect(penders.value.value).toBe(gauge.penders.value);
  });

  it('FYP SELF: gauge + comparison + one breakdown (7 products, plain CREDIT_POINTS), no VARIANT_VALUE/PENDERS (AC-P4-02-39/40)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/FYP`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON', 'BREAKDOWN']);
    const gauge = d.sections.find((s: any) => s.type === 'GAUGE');
    expect(gauge.penders).toBeDefined(); // AC-P4-02-39: Penders stays MONEY, gauge-legend-only
    const breakdown = d.sections.find((s: any) => s.type === 'BREAKDOWN');
    const productCodes = breakdown.rows.map((r: any) => r.productCode);
    expect(productCodes).toEqual([
      'LINKED_PREMIUM', 'REGULAR_PREMIUM', 'PSA', 'SINGLE_PREMIUM', 'CREDIT_POINTS', 'UNIT_TRUST', 'GROUP_PREMIUM',
    ]);
    // AC-P4-02-40: FYP's CREDIT_POINTS is a plain weightPct row, not TPC/PTPC's capped formula.
    const credit = breakdown.rows.find((r: any) => r.productCode === 'CREDIT_POINTS');
    expect(credit.weightPct).toBe(10);
  });

  it('FYP TEAM: still no Penders KPI card and no second (WITH_REPRICING) breakdown (AC-P4-02-39/40)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/FYP?scope=TEAM`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON', 'BREAKDOWN']);
    expect(d.sections.find((s: any) => s.type === 'PENDERS')).toBeUndefined();
    expect(d.sections.filter((s: any) => s.type === 'BREAKDOWN')).toHaveLength(1);
  });

  it('MANPOWER (TEAM): grouped bars + axis + ABS chips (AC-P4-02-10/11)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/MANPOWER?scope=TEAM`);
    expect(d.sections[0].type).toBe('BAR_COMPARISON');
    expect(d.sections[0].axisUnitCode).toBe('AGENTS');
    expect(d.sections[0].measures).toHaveLength(2);
    expect(d.sections[0].measures[1].points[1].change.display).toBe('ABS');
  });

  it('PERSISTENCY_Y1: threshold gauge 85 GTE, pp change (AC-P4-02-15)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/PERSISTENCY_Y1`);
    expect(d.sections[0].type).toBe('THRESHOLD_GAUGE');
    expect(d.sections[0].threshold.value).toBe(85);
    expect(d.sections[0].sentiment).toBe('POSITIVE');
  });

  it('EMPTY persona: dataState EMPTY, no sections (AC-P4-02-18)', async () => {
    const d = await getJson(app, 'AGENT_EMPTY', `${BFF}/performance/metrics/CASE_COUNT`);
    expect(d.dataState).toBe('EMPTY');
    expect(d.sections).toEqual([]);
  });

  it('PROCESSING persona (AC-P4-02-17)', async () => {
    const d = await getJson(app, 'AGENT_PROCESSING', `${BFF}/performance/metrics/CASE_COUNT`);
    expect(d.dataState).toBe('PROCESSING');
  });
});
