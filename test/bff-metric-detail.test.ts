import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson } from './support/bff-api.js';
import type { PersonaKey } from './support/personas.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF metric detail (S-P4-02)', () => {
  it('TPC SELF: section order incl. the Penders card + 2 breakdowns, no CREDIT_POINTS notice (AC-P4-02-01/03/33/58/59)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC`);
    expect(d.sections.map((s: any) => s.type)).toEqual(
      ['GAUGE', 'COMPARISON', 'VARIANT_VALUE', 'PENDERS', 'BREAKDOWN', 'BREAKDOWN'],
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

  // v1.20.0 (AC-P4-02-58/59): TPC/PTPC Penders card at SELF and TEAM for every persona.
  const pendersCases: Array<[PersonaKey, string, string, number]> = [
    ['AGENT_P4', 'TPC', '', 2],
    ['AGENT_P4', 'PTPC', '', 1],
    ['LEADER_P3', 'TPC', '', 2],
    ['LEADER_P3', 'PTPC', '', 1],
    ['LEADER_P3', 'TPC', '?scope=TEAM', 6],
    ['LEADER_P3', 'PTPC', '?scope=TEAM', 4],
    ['LEADER_P2', 'TPC', '', 2],
    ['LEADER_P2', 'PTPC', '', 1],
    ['LEADER_P2', 'TPC', '?scope=TEAM&teamView=DIRECT', 6],
    ['LEADER_P2', 'PTPC', '?scope=TEAM&teamView=DIRECT', 4],
    ['LEADER_P2', 'TPC', '?scope=TEAM&teamView=GROUP', 14],
    ['LEADER_P2', 'PTPC', '?scope=TEAM&teamView=GROUP', 9],
  ];
  it.each(pendersCases)('%s %s%s: Penders COUNT card after VARIANT_VALUE, gauge money penders untouched, no nav (AC-P4-02-57/58/59)', async (persona, code, query, count) => {
    const d = await getJson(app, persona, `${BFF}/performance/metrics/${code}${query}`);
    expect(d.sections.map((s: any) => s.type)).toEqual(
      ['GAUGE', 'COMPARISON', 'VARIANT_VALUE', 'PENDERS', 'BREAKDOWN', 'BREAKDOWN'],
    );
    const penders = d.sections.find((s: any) => s.type === 'PENDERS');
    expect(penders.value).toEqual({ kind: 'COUNT', value: count });
    expect(penders.nav).toBeUndefined();
    expect(d.sections.find((s: any) => s.type === 'GAUGE').penders.kind).toBe('MONEY');
  });

  it('CASE_COUNT SELF: bars + comparison (Figma Metric Drill downs), no Penders anywhere (AC-P4-02-37)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/CASE_COUNT`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['BAR_COMPARISON', 'COMPARISON']);
    expect(d.sections.find((s: any) => s.type === 'GAUGE')).toBeUndefined();
    expect(d.sections.find((s: any) => s.type === 'PENDERS')).toBeUndefined();
  });

  it('CASE_COUNT TEAM: bars + comparison and its own Penders KPI card, with no gauge legend (AC-P4-02-37)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/CASE_COUNT?scope=TEAM`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['BAR_COMPARISON', 'COMPARISON', 'PENDERS']);
    const bars = d.sections.find((s: any) => s.type === 'BAR_COMPARISON');
    expect(bars.years).toHaveLength(2);
    const penders = d.sections.find((s: any) => s.type === 'PENDERS');
    expect(penders.value.kind).toBe('COUNT');
  });

  it('FYP SELF: gauge + comparison only (like FYC), no breakdown/VARIANT_VALUE/PENDERS', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/FYP`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON']);
    const gauge = d.sections.find((s: any) => s.type === 'GAUGE');
    expect(gauge.penders).toBeDefined(); // AC-P4-02-39: Penders stays MONEY, gauge-legend-only
  });

  it('FYP TEAM: still no Penders KPI card and no breakdown', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/FYP?scope=TEAM`);
    expect(d.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON']);
  });

  it('MANPOWER (TEAM): stacked Existing Agents + New Recruits, chip on totals only (AC-P4-02-10/42/43)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/MANPOWER?scope=TEAM`);
    const bars = d.sections[0];
    expect(bars.type).toBe('BAR_COMPARISON');
    expect(bars.axisUnitCode).toBe('AGENTS');
    expect(bars.layout).toBe('STACKED');
    expect(bars.measures.map((m: any) => m.measureCode)).toEqual(['EXISTING_AGENTS', 'NEW_RECRUITS']);
    for (const m of bars.measures) for (const p of m.points) expect(p.change).toBeUndefined();
    bars.totals.forEach((t: any, i: number) =>
      expect(t.value.value).toBe(bars.measures[0].points[i].value.value + bars.measures[1].points[i].value.value));
    expect(bars.totals[0].change).toBeUndefined();
    expect(bars.totals[1].change.display).toBe('PCT');
  });

  it('MANPOWER (TEAM): comparison is Total Manpower with a rounded-up PCT change (AC-P4-02-44/45)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/MANPOWER?scope=TEAM`);
    const cmp = d.sections.find((s: any) => s.type === 'COMPARISON');
    expect(cmp.change.display).toBe('PCT');
    expect(cmp.change.abs).toBeUndefined();
    expect(Number.isInteger(cmp.change.pct)).toBe(true);
    const bars = d.sections[0];
    expect(cmp.current).toEqual(bars.totals[1].value);
    expect(cmp.prior).toEqual(bars.totals[0].value);
    expect(bars.totals[1].change.pct).toBe(cmp.change.pct);
  });

  it('PERSISTENCY_Y1: threshold gauge 85 GTE (AC-P4-02-15)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/PERSISTENCY_Y1`);
    expect(d.sections[0].type).toBe('THRESHOLD_GAUGE');
    expect(d.sections[0].threshold.value).toBe(85);
    expect(d.sections[0].sentiment).toBe('POSITIVE');
  });

  it('persistency renders only the threshold gauge, SELF and TEAM; ACTIVITY_RATIO keeps its comparison (AC-P4-02-46)', async () => {
    for (const code of ['PERSISTENCY_CY', 'PERSISTENCY_Y1', 'PERSISTENCY_Y2']) {
      const self = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/${code}`);
      const team = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/${code}?scope=TEAM&teamView=GROUP`);
      expect(self.sections.map((s: any) => s.type)).toEqual(['THRESHOLD_GAUGE']);
      expect(team.sections.map((s: any) => s.type)).toEqual(['THRESHOLD_GAUGE']);
    }
    const ar = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/ACTIVITY_RATIO?scope=TEAM`);
    expect(ar.sections.map((s: any) => s.type)).toEqual(['THRESHOLD_GAUGE', 'COMPARISON']);
  });

  it('ACTIVITY_RATIO change is a relative, rounded-up PCT; threshold gauge unchanged (AC-P4-02-48/49)', async () => {
    const ar = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/ACTIVITY_RATIO?scope=TEAM`);
    const gauge = ar.sections.find((s: any) => s.type === 'THRESHOLD_GAUGE');
    expect(gauge.threshold).toEqual({ value: 90, comparator: 'GTE' });
    const cmp = ar.sections.find((s: any) => s.type === 'COMPARISON');
    expect(cmp.change.display).toBe('PCT');
    expect(cmp.change.pp).toBeUndefined();
    expect(Number.isInteger(cmp.change.pct)).toBe(true);
    const cur = cmp.current.value; const pri = cmp.prior.value;
    const exact = ((cur - pri) / pri) * 100;
    expect(Math.abs(cmp.change.pct)).toBe(Math.ceil(Math.abs(exact) - 1e-9));
    expect(cmp.change.direction).toBe(cur > pri ? 'UP' : cur < pri ? 'DOWN' : 'FLAT');
  });

  it('PRODUCTIVITY renders BAR_COMPARISON + COMPARISON (Figma Metric Drill downs); change is a relative, rounded-up PCT with DECIMAL values (AC-P4-02-50/51)', async () => {
    const p = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/PRODUCTIVITY?scope=TEAM`);
    expect(p.sections.map((s: any) => s.type)).toEqual(['BAR_COMPARISON', 'COMPARISON']);
    const cmp = p.sections.find((s: any) => s.type === 'COMPARISON');
    expect(cmp.current).toMatchObject({ kind: 'DECIMAL', value: 9.7 });
    expect(cmp.prior).toMatchObject({ kind: 'DECIMAL', value: 9.3 });
    expect(cmp.change).toMatchObject({ display: 'PCT', pct: 5, direction: 'UP', sentiment: 'POSITIVE' });
    expect(cmp.change.abs).toBeUndefined();
  });

  it('AVERAGE_CASE_SIZE keeps GAUGE + COMPARISON; change is a relative, rounded-up PCT with MONEY values (AC-P4-02-52/53, OQ-66)', async () => {
    const a = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/AVERAGE_CASE_SIZE?scope=TEAM`);
    expect(a.sections.map((s: any) => s.type)).toEqual(['GAUGE', 'COMPARISON']); // no bar chart until OQ-66 is ruled
    const gauge = a.sections.find((s: any) => s.type === 'GAUGE');
    expect(gauge.collected.kind).toBe('MONEY');
    expect(gauge.penders).toBeUndefined();
    const cmp = a.sections.find((s: any) => s.type === 'COMPARISON');
    expect(cmp.current.kind).toBe('MONEY');
    expect(cmp.prior.kind).toBe('MONEY');
    expect(cmp.change.display).toBe('PCT');
    expect(cmp.change.abs).toBeUndefined();
    expect(Number.isInteger(cmp.change.pct)).toBe(true);
    const cur = Number(cmp.current.amount); const pri = Number(cmp.prior.amount);
    const exact = ((cur - pri) / pri) * 100;
    expect(Math.abs(cmp.change.pct)).toBe(Math.ceil(Math.abs(exact) - 1e-9));
    expect(cmp.change.direction).toBe(cur > pri ? 'UP' : cur < pri ? 'DOWN' : 'FLAT');
  });

  it('persistency is always YTD whatever the dashboard period; other metrics keep theirs (AC-P4-02-47)', async () => {
    for (const code of ['PERSISTENCY_CY', 'PERSISTENCY_Y1', 'PERSISTENCY_Y2']) {
      const ytd = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/${code}?period=YTD`);
      for (const period of ['MTD', 'QTD']) {
        const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/${code}?period=${period}`);
        expect(d.context.period).toBe('YTD');
        expect(d.dataState).toBe('OK');
        expect(d.sections).toEqual(ytd.sections);
      }
    }
    const team = await getJson(app, 'LEADER_P2', `${BFF}/performance/metrics/PERSISTENCY_Y2?scope=TEAM&teamView=DIRECT&period=MTD&businessLine=TAKAFUL`);
    expect(team.context).toMatchObject({ period: 'YTD', teamView: 'DIRECT', businessLine: 'TAKAFUL' });
    const tpc = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC?period=MTD`);
    expect(tpc.context.period).toBe('MTD');
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
