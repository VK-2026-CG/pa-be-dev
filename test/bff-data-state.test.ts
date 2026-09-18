/**
 * Card-level data states (mongodb.md §7.13, insights.v1 `MetricSnapshot.dataState`,
 * performance-vm v1.5.0). A catalogued metric with no approved upstream source must
 * be returned as a renderable card state — metricCode/valueType/nav intact, `value`
 * absent — instead of being silently omitted from the dashboard. A missing value is
 * never zero-filled or synthesized (§7.12).
 */
import { describe, it, expect } from 'vitest';
process.env.MONGODB_URI = ''; // tests always run the in-memory engine

import { composeDashboard } from '../src/bff/compose/dashboard.js';
import type { DomainApi } from '../src/bff/domain-client.js';
import type { Persona } from '../src/bff/persona.js';

const P4: Persona = { id: 'AGENT_P4', agentId: 'A1001', level: 'P4', label: 'P4' };
const SELF_LENS = { period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' } as const;
const money = (amount: string) => ({ kind: 'MONEY', amount, currency: 'MYR' });
const CONTEXT = {
  period: { type: 'YTD', startDate: '2026-01-01', endDate: '2026-07-27' },
  businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF', asOfDate: '2026-07-27',
};

/** Back-compat domain item: no `dataState` at all ⇒ treated as OK. */
const okSnap = (metricCode: string) => ({
  metricCode, valueType: 'MONEY', collected: money('100000.00'),
  goal: { state: 'NOT_SET' }, asOfDate: '2026-07-27',
});
/** §7.13 shape: catalogued but unbacked — no `collected`, no `goal`. */
const emptySnap = (metricCode: string, extra: object = {}) => ({
  metricCode, valueType: 'MONEY', dataState: 'EMPTY', asOfDate: '2026-07-27', ...extra,
});

function stubApi(items: unknown[]): DomainApi {
  return {
    metrics: async () => ({ context: CONTEXT, items }),
    preferences: async () => ({
      priorityMetricCodes: ['TPC', 'FYP'], focusMetricCodes: ['FYC'],
      source: 'DEFAULT', updatedAt: null,
    }),
    milestones: async () => ({ asOfDate: '2026-07-27', items: [] }),
    recommendations: async () => ({ items: [], generatedAt: '2026-07-27T00:00:00Z' }),
    definitions: async () => ({ country: 'MY', items: [] }),
    metricDetail: async () => ({}),
    series: async () => ({}),
    putPreferences: async () => ({}),
    feedback: async () => undefined,
  } as unknown as DomainApi;
}

describe('dashboard cards — dataState (S-P4-01, C1 §7.13)', () => {
  it('EMPTY domain item still renders a card: no value, dataState EMPTY, metricCode + nav intact', async () => {
    const vm = await composeDashboard(stubApi([okSnap('TPC'), emptySnap('FYP')]), P4, SELF_LENS);

    // The unbacked metric is NOT dropped — it keeps its slot in the priority row.
    expect(vm.priorityMetrics.map((c) => c.metricCode)).toEqual(['TPC', 'FYP']);

    const empty = vm.priorityMetrics[1]!;
    expect(empty.metricCode).toBe('FYP');
    expect(empty.dataState).toBe('EMPTY');
    expect(empty.value).toBeUndefined();
    // Omitted, not zero-filled/synthesized (§7.12) — the key must be absent entirely.
    expect(Object.keys(empty)).not.toContain('value');
    expect(empty.valueType).toBe('MONEY');
    expect(empty.showGoal).toBe(true);
    expect(empty.goal).toBeUndefined();
    expect(empty.nav.route).toBe('insights/metric-detail');
    expect(empty.nav.params).toMatchObject({ metricCode: 'FYP', period: 'YTD', scope: 'SELF' });
  });

  it('back-compat: a domain item with no dataState defaults to OK and still yields a value', async () => {
    const vm = await composeDashboard(stubApi([okSnap('TPC'), emptySnap('FYP')]), P4, SELF_LENS);

    const ok = vm.priorityMetrics[0]!;
    expect(ok.metricCode).toBe('TPC');
    expect(ok.value).toEqual(money('100000.00'));
    expect(ok.goal).toEqual({ state: 'NOT_SET' });
    // dataState omitted for OK cards — the contract's default (unchanged payload).
    expect(ok.dataState).toBeUndefined();
  });

  it('passes notices through and applies the same rule to the focus row', async () => {
    const notices = [{ code: 'NO_UPSTREAM_SOURCE', severity: 'WARNING', params: { metricCode: 'FYC' } }];
    const vm = await composeDashboard(
      stubApi([okSnap('TPC'), okSnap('FYP'), emptySnap('FYC', { notices })]), P4, SELF_LENS,
    );

    const focus = vm.focusMetrics.items[0]!;
    expect(focus.metricCode).toBe('FYC');
    expect(focus.dataState).toBe('EMPTY');
    expect(focus.value).toBeUndefined();
    expect(focus.showGoal).toBe(false); // focus cards never show goals
    expect(focus.notices).toEqual(notices);
  });
});

// Legacy snapshot-adapter tests were replaced by the direct-source contract tests
// in performance-source.test.ts; the BFF rendering contract above is preserved.
