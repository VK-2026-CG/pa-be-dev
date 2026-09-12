import { describe, it, expect } from 'vitest';
import { composeDashboard } from '../src/bff/compose/dashboard.js';
import { composeMetricDetail } from '../src/bff/compose/metric-detail.js';
import { composeCustomize } from '../src/bff/compose/customize.js';
import type { DomainApi } from '../src/bff/domain-client.js';
import type { Persona } from '../src/bff/persona.js';

const P2: Persona = { id: 'LEADER_P2', agentId: 'L3001', level: 'P2', label: 'P2' };
const P3: Persona = { id: 'LEADER_P3', agentId: 'L2001', level: 'P3', label: 'P3' };
const P4: Persona = { id: 'AGENT_P4', agentId: 'A1001', level: 'P4', label: 'P4' };

const money = (amount: string) => ({ kind: 'MONEY', amount, currency: 'MYR' });
const snap = (metricCode: string, extra: object = {}) => ({
  metricCode, valueType: 'MONEY', variant: 'WITHOUT_REPRICING',
  collected: money('100000.00'), goal: { state: 'NOT_SET' },
  comparison: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', pct: 27 },
  ...extra,
});
const CONTEXT = {
  period: { type: 'YTD', startDate: '2026-01-01', endDate: '2026-07-27' },
  businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF', asOfDate: '2026-07-27',
};

function stubApi(over: Partial<Record<keyof DomainApi, unknown>> = {}): DomainApi {
  const base: Record<string, unknown> = {
    metrics: async () => ({
      context: CONTEXT,
      items: [snap('TPC'), snap('PTPC'), snap('CASE_COUNT', { valueType: 'COUNT', collected: { kind: 'COUNT', value: 12 }, variant: undefined }), snap('FYP'), snap('FYC'), snap('PERSISTENCY_CY', { valueType: 'PERCENT', collected: { kind: 'PERCENT', value: 98 }, variant: undefined, comparison: undefined })],
    }),
    preferences: async () => ({
      priorityMetricCodes: ['TPC', 'PTPC', 'CASE_COUNT', 'FYP'],
      focusMetricCodes: ['FYC', 'PERSISTENCY_CY'],
      source: 'DEFAULT', updatedAt: null,
    }),
    milestones: async () => ({
      asOfDate: '2026-07-27',
      items: [{
        programCode: 'MDRT_SERIES', variant: 'WITHOUT_REPRICING', cycleYear: 2026,
        currentTier: { code: 'MDRT' }, nextTier: { code: 'COT' }, progressPct: 60,
        measures: [{ measureCode: 'FYP', achieved: money('600000.00'), target: money('798400.00') }],
      }],
    }),
    recommendations: async () => ({
      items: [{ id: 'r1' }],
      panel: {
        recommendationId: 'reco-1',
        flags: [{ code: 'PERFORMANCE_DROPS', severity: 'CRITICAL' }],
        highlight: { metricCode: 'TPC', achieved: money('152000.00'), goal: { state: 'SET', target: money('200000.00'), progressPct: 76 }, runRateDeltaPct: 8 },
        insights: [{ code: 'i1', titleCode: 'CRITICAL_ANOMALIES', narrative: 'x' }],
        cta: { route: 'insights/team-drilldown' },
        generatedAt: '2026-07-13T02:06:00Z',
      },
      generatedAt: '2026-07-13T02:06:00Z',
    }),
    definitions: async () => ({ country: 'MY', items: [] }),
    metricDetail: async () => ({}),
    series: async () => ({}),
    putPreferences: async () => ({}),
    feedback: async () => undefined,
  };
  return { ...base, ...over } as DomainApi;
}

const SELF_LENS = { period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' } as const;

describe('composeDashboard (S-P4-01)', () => {
  it('applies PTPC showGoal=false from MY config (AC-P4-01-06) and pref order for priority', async () => {
    const vm = await composeDashboard(stubApi(), P4, SELF_LENS);
    expect(vm.priorityMetrics.map((c) => c.metricCode)).toEqual(['TPC', 'PTPC', 'CASE_COUNT', 'FYP']);
    expect(vm.priorityMetrics[0]!.showGoal).toBe(true);
    expect(vm.priorityMetrics[1]!.showGoal).toBe(false);
    expect(vm.meta).toMatchObject({ screenId: 'S-P4-01', country: 'MY', asOfDate: '2026-07-27', partial: false });
  });

  it('focus row = selected focus metrics only, cards never show goals (AC-P4-01-17)', async () => {
    const vm = await composeDashboard(stubApi(), P4, SELF_LENS);
    expect(vm.focusMetrics.items.map((c) => c.metricCode)).toEqual(['FYC', 'PERSISTENCY_CY']);
    expect(vm.focusMetrics.items.every((c) => c.showGoal === false)).toBe(true);
  });

  it('non-leader gets no scope switcher; leader does (AC-P4-01-19/-14)', async () => {
    const agentVm = await composeDashboard(stubApi(), P4, SELF_LENS);
    expect(agentVm.scopeSwitcher).toBeUndefined();
    const leaderVm = await composeDashboard(stubApi(), P2, SELF_LENS);
    expect(leaderVm.scopeSwitcher?.options.map((o) => o.scope)).toEqual(['SELF', 'TEAM']);
  });

  it('Group toggle only for P2 in TEAM scope; SELF never sends teamView (AC-P4-01-15/16/24)', async () => {
    const teamLens = { ...SELF_LENS, scope: 'TEAM', teamView: 'DIRECT' } as const;
    const p2 = await composeDashboard(stubApi(), P2, teamLens);
    expect(p2.filters.teamViewToggleVisible).toBe(true);
    expect(p2.filters.teamView).toBe('DIRECT');
    expect(p2.filters.basisToggleVisible).toBe(false); // MY TEAM config hides Scheme
    const p3 = await composeDashboard(stubApi(), P3, teamLens);
    expect(p3.filters.teamViewToggleVisible).toBe(false);
    const self = await composeDashboard(stubApi(), P2, SELF_LENS);
    expect(self.filters.teamView).toBeUndefined();
    expect(self.filters.basisToggleVisible).toBe(true);
  });

  it('MTD/QTD/YTD sheet meta comes BFF-computed from asOfDate (AC-P4-01-23)', async () => {
    const vm = await composeDashboard(stubApi(), P4, SELF_LENS);
    expect(vm.filters.periodOptionsMeta).toEqual([
      { period: 'MTD', startDate: '2026-07-01' },
      { period: 'QTD', startDate: '2026-07-01' },
      { period: 'YTD', startDate: '2026-01-01' },
    ]);
  });

  it('degrades, not fails: reco outage → partial payload with failedSections (meta contract)', async () => {
    const vm = await composeDashboard(
      stubApi({ recommendations: async () => { throw new Error('boom'); } }), P4, SELF_LENS,
    );
    expect(vm.meta.partial).toBe(true);
    expect(vm.meta.failedSections).toContain('recommendations');
    expect(vm.recommendations.panel).toBeUndefined();
    expect(vm.priorityMetrics.length).toBeGreaterThan(0);
  });

  it('maps the AI panel incl. feedback + CTA (S-P23-01)', async () => {
    const vm = await composeDashboard(stubApi(), P2, SELF_LENS);
    expect(vm.recommendations.panel).toMatchObject({
      recommendationId: 'reco-1',
      cta: { labelCode: 'VIEW_TEAM_DRILLDOWN', nav: { route: 'insights/team-drilldown' } },
    });
    expect(vm.recommendations.panel!.highlight!.goal!.progressPct).toBe(76);
  });
});

describe('composeMetricDetail (S-P4-02)', () => {
  const detailApi = (payload: object) => stubApi({ metricDetail: async () => payload });

  it('orders sections per config and skips missing capabilities: FYP = gauge + comparison only (AC-P4-02-01/02)', async () => {
    const api = detailApi({
      metricCode: 'FYP', valueType: 'MONEY', context: CONTEXT, dataState: 'OK',
      primary: { collected: money('360000.00'), penders: money('54000.00') },
      comparison: { current: money('360000.00'), prior: money('283460.00'), priorYear: 2025, change: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', pct: 27 } },
    });
    const vm = await composeMetricDetail(api, P4, 'FYP', SELF_LENS);
    expect(vm.sections.map((s) => s.type)).toEqual(['GAUGE', 'COMPARISON']);
    expect(vm.historyNav).toMatchObject({ route: 'insights/history', params: { metricCode: 'FYP' } });
  });

  it('TPC full stack in config order, with notices passthrough (v1.2.0)', async () => {
    const api = detailApi({
      metricCode: 'TPC', valueType: 'MONEY', context: CONTEXT, dataState: 'OK',
      notices: [{ code: 'PRODUCT_DATA_MISSING', severity: 'WARNING', params: { productCode: 'CREDIT_POINTS' } }],
      primary: { variant: 'WITHOUT_REPRICING', collected: money('100000.00'), penders: money('30000.00') },
      altVariants: [{ variant: 'WITH_REPRICING', collected: money('120000.00') }],
      comparison: { current: money('100000.00'), prior: money('78740.00'), priorYear: 2025, change: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', pct: 27 } },
      breakdowns: [
        { variant: 'WITHOUT_REPRICING', columns: ['INSURANCE', 'TAKAFUL'], rows: [], totals: [] },
        { variant: 'WITH_REPRICING', columns: ['INSURANCE', 'TAKAFUL'], rows: [], totals: [] },
      ],
    });
    const vm = await composeMetricDetail(api, P4, 'TPC', SELF_LENS);
    expect(vm.sections.map((s) => s.type)).toEqual(['GAUGE', 'COMPARISON', 'VARIANT_VALUE', 'BREAKDOWN', 'BREAKDOWN']);
    expect(vm.notices).toHaveLength(1);
    expect(vm.sections.find((s) => s.type === 'VARIANT_VALUE')).toMatchObject({ periodLabelYear: 2026 });
  });

  it('threshold metric renders THRESHOLD_GAUGE (not GAUGE) with sentiment from comparator (AC-P4-02-15)', async () => {
    const api = detailApi({
      metricCode: 'PERSISTENCY_Y2', valueType: 'PERCENT', context: CONTEXT, dataState: 'OK',
      primary: { collected: { kind: 'PERCENT', value: 82 } },
      threshold: { value: 80, comparator: 'GTE' },
      comparison: { current: { kind: 'PERCENT', value: 82 }, prior: { kind: 'PERCENT', value: 84 }, priorYear: 2025, change: { basis: 'LAST_YEAR', direction: 'DOWN', sentiment: 'NEGATIVE', pp: -2 } },
    });
    const vm = await composeMetricDetail(api, P4, 'PERSISTENCY_Y2', SELF_LENS);
    const types = vm.sections.map((s) => s.type);
    expect(types[0]).toBe('THRESHOLD_GAUGE');
    expect(types).not.toContain('GAUGE');
    expect(vm.sections[0]).toMatchObject({ sentiment: 'POSITIVE', threshold: { value: 80 } });
  });

  it('bar metric renders BAR_COMPARISON first (no gauge); team chip present (AC-P4-02-10/11)', async () => {
    const api = detailApi({
      metricCode: 'MANPOWER', valueType: 'COUNT',
      context: { ...CONTEXT, scope: 'TEAM', teamView: 'DIRECT' }, dataState: 'OK',
      primary: { collected: { kind: 'COUNT', value: 25 } },
      comparison: { current: { kind: 'COUNT', value: 25 }, prior: { kind: 'COUNT', value: 18 }, priorYear: 2025, change: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', abs: { kind: 'COUNT', value: 7 } } },
      barComparison: {
        years: [2025, 2026], axis: { unitCode: 'AGENTS' },
        measures: [
          { measureCode: 'OPENING', points: [{ year: 2025, value: { kind: 'COUNT', value: 7 } }, { year: 2026, value: { kind: 'COUNT', value: 10 }, change: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', abs: { kind: 'COUNT', value: 3 } } }] },
          { measureCode: 'CLOSING', points: [{ year: 2025, value: { kind: 'COUNT', value: 18 } }, { year: 2026, value: { kind: 'COUNT', value: 25 }, change: { basis: 'LAST_YEAR', direction: 'UP', sentiment: 'POSITIVE', abs: { kind: 'COUNT', value: 7 } } }] },
        ],
      },
    });
    const vm = await composeMetricDetail(api, P2, 'MANPOWER', { ...SELF_LENS, scope: 'TEAM', teamView: 'DIRECT' });
    expect(vm.context.teamView).toBe('DIRECT');
    expect(vm.sections.map((s) => s.type)).toEqual(['BAR_COMPARISON', 'COMPARISON']);
    const bars = vm.sections[0]!;
    expect(bars).toMatchObject({ axisUnitCode: 'AGENTS' });
    if (bars.type === 'BAR_COMPARISON') {
      expect(bars.measures[1]!.points[1]!.change).toMatchObject({ display: 'ABS' });
    }
  });

  it('non-OK dataState yields empty sections (AC-P4-02-17/18)', async () => {
    const api = detailApi({ metricCode: 'CASE_COUNT', valueType: 'COUNT', context: CONTEXT, dataState: 'EMPTY' });
    const vm = await composeMetricDetail(api, P4, 'CASE_COUNT', SELF_LENS);
    expect(vm.dataState).toBe('EMPTY');
    expect(vm.sections).toEqual([]);
  });
});

describe('composeCustomize (S-P4-04)', () => {
  const defs = [
    { metricCode: 'TPC', valueType: 'MONEY', category: 'PRIORITY', defaultSelected: true, defaultOrder: 1, customizable: false, scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT', capabilities: { repricing: true } },
    { metricCode: 'FYP', valueType: 'MONEY', category: 'PRIORITY', defaultSelected: true, defaultOrder: 2, customizable: false, scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT', capabilities: {} },
    { metricCode: 'FYC', valueType: 'MONEY', category: 'FOCUS', defaultSelected: true, defaultOrder: 1, customizable: true, scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PCT', capabilities: {} },
    { metricCode: 'PERSISTENCY_Y1', valueType: 'PERCENT', category: 'FOCUS', defaultSelected: false, defaultOrder: 3, customizable: true, scopes: ['SELF', 'TEAM'], favourability: 'HIGHER_IS_BETTER', changeDisplay: 'PP', capabilities: {} },
  ];
  it('locked priority rows + selected-first focus list per scope prefs (AC-P4-04-01/07)', async () => {
    const api = stubApi({
      definitions: async () => ({ country: 'MY', items: defs }),
      preferences: async () => ({ priorityMetricCodes: ['FYP', 'TPC'], focusMetricCodes: ['FYC'], source: 'AGENT', updatedAt: 'x' }),
    });
    const vm = await composeCustomize(api, P4, 'SELF');
    expect(vm.scope).toBe('SELF');
    expect(vm.priority.map((i) => i.metricCode)).toEqual(['FYP', 'TPC']); // saved order wins
    expect(vm.priority.every((i) => i.locked && i.selected && i.reorderable)).toBe(true);
    expect(vm.priority[1]).toMatchObject({ variant: 'WITHOUT_REPRICING' });
    expect(vm.focus.map((i) => [i.metricCode, i.selected])).toEqual([['FYC', true], ['PERSISTENCY_Y1', false]]);
    expect(vm.constraints.priority).toEqual({ min: 4, max: 4, editable: false });
  });
});
