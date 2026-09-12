/**
 * Card-level data states (mongodb.md §7.13, insights.v1 `MetricSnapshot.dataState`,
 * performance-vm v1.5.0). A catalogued metric with no approved upstream source must
 * be returned as a renderable card state — metricCode/valueType/nav intact, `value`
 * absent — instead of being silently omitted from the dashboard. A missing value is
 * never zero-filled or synthesized (§7.12).
 */
import { describe, it, expect } from 'vitest';
process.env.MONGODB_URI = ''; // tests always run the in-memory engine

import type { Db } from 'mongodb';
import { composeDashboard } from '../src/bff/compose/dashboard.js';
import { MongoSource } from '../src/data/source.js';
import type { DomainApi } from '../src/bff/domain-client.js';
import type { Persona } from '../src/bff/persona.js';
import type { AgentRecord } from '../src/data/registry.js';
import type { Lens } from '../src/data/values.js';

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

/* ── MongoSource: a requested-but-absent snapshot doc resolves to EMPTY ──── */

const fakeDb = (docs: unknown[]) => ({
  collection: () => ({ find: () => ({ sort: () => ({ toArray: async () => docs }) }) }),
}) as unknown as Db;

const AGENT: AgentRecord = { agentId: 'A1001', tenant: 'MY', level: 'P4', name: 'Aisyah Rahman' };
const LENS: Lens = { period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' };

describe('MongoSource.metricList — absent documents (C1 §7.13, OQ-PA-09)', () => {
  it('emits EMPTY items for catalogued metrics with no snapshot doc, instead of dropping them', async () => {
    const src = new MongoSource(fakeDb([
      { metricCode: 'TPC', order: 1, context: CONTEXT, payload: okSnap('TPC') },
    ]));

    const list = (await src.metricList(AGENT, LENS, 'PRIORITY'))!;
    expect(list.context).toEqual(CONTEXT);

    // SELF/STANDARD priority catalog = TPC, PTPC, CASE_COUNT, FYP. Only TPC materialized.
    expect(list.items.map((i) => i.metricCode).sort())
      .toEqual(['CASE_COUNT', 'FYP', 'PTPC', 'TPC']);

    const byCode = new Map(list.items.map((i) => [i.metricCode, i]));
    // Present doc: payload returned verbatim, untouched.
    expect(byCode.get('TPC')).toEqual(okSnap('TPC'));
    expect(byCode.get('TPC')!.dataState).toBeUndefined();

    for (const code of ['PTPC', 'CASE_COUNT', 'FYP']) {
      const item = byCode.get(code)!;
      // EMPTY, never PROCESSING — `batch_control` does not exist here (OQ-PA-09).
      expect(item.dataState).toBe('EMPTY');
      expect(item.collected).toBeUndefined();
      expect(item.goal).toBeUndefined();
      expect(item.valueType).toBeTruthy();
      expect(item.asOfDate).toBe('2026-07-27');
    }
  });

  it('materialized rows keep their pipeline `order` sort; placeholders trail them', async () => {
    const src = new MongoSource(fakeDb([
      { metricCode: 'FYP', order: 1, context: CONTEXT, payload: okSnap('FYP') },
      { metricCode: 'TPC', order: 2, context: CONTEXT, payload: okSnap('TPC') },
    ]));

    const list = (await src.metricList(AGENT, LENS, 'PRIORITY'))!;
    expect(list.items.map((i) => i.metricCode)).toEqual(['FYP', 'TPC', 'PTPC', 'CASE_COUNT']);
    expect(list.items.slice(0, 2).every((i) => i.dataState === undefined)).toBe(true);
  });

  it('only fills in the codes that were requested', async () => {
    const src = new MongoSource(fakeDb([
      { metricCode: 'TPC', order: 1, context: CONTEXT, payload: okSnap('TPC') },
    ]));

    const list = (await src.metricList(AGENT, LENS, 'ALL', ['TPC', 'FYC']))!;
    expect(list.items.map((i) => i.metricCode)).toEqual(['TPC', 'FYC']);
    expect(list.items[1]!.dataState).toBe('EMPTY');
  });

  it('no documents at all still returns undefined (404 semantics unchanged)', async () => {
    const src = new MongoSource(fakeDb([]));
    expect(await src.metricList(AGENT, LENS, 'PRIORITY')).toBeUndefined();
  });
});
