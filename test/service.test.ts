import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
import { _resetPreferences } from '../src/data/preferences.js';

const app = buildApp(await createSource());
const H = (agentId: string) => ({ 'x-agent-id': agentId });

beforeEach(() => _resetPreferences());

describe('metrics list (S-P4-01)', () => {
  it('SELF/STANDARD returns the 4 locked priority metrics in order; PTPC has no goal capability', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics?listScope=PRIORITY', headers: H('A1001') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.context.scope).toBe('SELF');
    expect(body.items.map((i: any) => i.metricCode)).toEqual(['TPC', 'PTPC', 'CASE_COUNT', 'FYP']);
    const tpc = body.items[0];
    expect(tpc.collected).toEqual({ kind: 'MONEY', amount: '100000.00', currency: 'MYR' });
    expect(tpc.variant).toBe('WITHOUT_REPRICING');
    expect(tpc.goal.state).toBe('NOT_SET');
    expect(tpc.comparison.pct).toBe(27);
    expect(tpc.comparison.sentiment).toBe('POSITIVE');
    const ptpc = body.items[1];
    expect(ptpc.comparison.sentiment).toBe('NEGATIVE');
  });

  it('business line tabs change values (AC-P4-01-03): INSURANCE ≠ TAKAFUL, and they sum to ALL for money', async () => {
    const get = async (bl: string) =>
      (await app.inject({ url: `/insights/v1/agents/A1001/metrics?businessLine=${bl}&codes=TPC`, headers: H('A1001') })).json().items[0].collected.amount;
    const [all, ins, tak] = await Promise.all([get('ALL'), get('INSURANCE'), get('TAKAFUL')]);
    expect(ins).toBe('80000.00');
    expect(tak).toBe('20000.00');
    expect(all).toBe('100000.00');
  });

  it('SCHEME re-composes the catalog (D-13): smaller re-ordered set with goals SET', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics?basis=SCHEME&listScope=PRIORITY', headers: H('A1001') });
    const body = res.json();
    expect(body.items.map((i: any) => i.metricCode)).toEqual(['TPC', 'FYP', 'CASE_COUNT']);
    expect(body.items[0].goal.state).toBe('SET');
  });

  it('TEAM/DIRECT for a leader returns 9 priority metrics incl. MAPA; MANPOWER has subMeasures', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/L2001/metrics?scope=TEAM&listScope=PRIORITY', headers: H('L2001') });
    const body = res.json();
    expect(body.items).toHaveLength(9);
    expect(body.context.teamView).toBe('DIRECT');
    const mp = body.items.find((i: any) => i.metricCode === 'MANPOWER');
    expect(mp.subMeasures.map((m: any) => m.measureCode)).toEqual(['OPENING', 'CLOSING']);
    expect(mp.comparison.abs.kind).toBe('COUNT');
  });
});

describe('scope/level gating (D-14)', () => {
  it('P4 agent requesting scope=TEAM → 403 INS-4032', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics?scope=TEAM', headers: H('A1001') });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INS-4032');
  });
  it('P3 leader requesting teamView=GROUP → 403 INS-4031 (AC-P4-01-24)', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/L2001/metrics?scope=TEAM&teamView=GROUP', headers: H('L2001') });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('INS-4031');
  });
  it('P2 leader may request GROUP; values scale above DIRECT', async () => {
    const direct = (await app.inject({ url: '/insights/v1/agents/L3001/metrics?scope=TEAM&teamView=DIRECT&codes=TPC', headers: H('L3001') })).json();
    const group = (await app.inject({ url: '/insights/v1/agents/L3001/metrics?scope=TEAM&teamView=GROUP&codes=TPC', headers: H('L3001') })).json();
    expect(group.context.teamView).toBe('GROUP');
    expect(Number(group.items[0].collected.amount)).toBeGreaterThan(Number(direct.items[0].collected.amount));
  });
  it('another P4 agent cannot read someone else’s data → 403', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/L2001/metrics', headers: H('A1001') });
    expect(res.statusCode).toBe(403);
  });
});

describe('metric detail (S-P4-02)', () => {
  it('TPC: primary+penders, comparison, WITH_REPRICING alt, 2 breakdowns w/o CREDIT_POINTS + notice, totals sum rows', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics/TPC', headers: H('A1001') });
    const d = res.json();
    expect(d.dataState).toBe('OK');
    expect(d.primary.penders.amount).toBe('30000.00');
    expect(d.altVariants[0]).toMatchObject({ variant: 'WITH_REPRICING', collected: { amount: '120000.00' } });
    expect(d.comparison).toMatchObject({ prior: { amount: '78740.00' }, priorYear: 2025 });
    expect(d.breakdowns).toHaveLength(2);
    const rows = d.breakdowns[0].rows;
    expect(rows.map((r: any) => r.productCode)).not.toContain('CREDIT_POINTS');
    expect(d.notices[0]).toMatchObject({ code: 'PRODUCT_DATA_MISSING', params: { productCode: 'CREDIT_POINTS' } });
    const insTotal = rows.reduce((acc: number, r: any) => acc + Number(r.cells[0].value.amount), 0);
    expect(Number(d.breakdowns[0].totals[0].value.amount)).toBeCloseTo(insTotal, 2);
    const psa = rows.find((r: any) => r.productCode === 'PSA');
    expect(psa.weightPct).toBe(10);
  });

  it('PERSISTENCY_Y1 carries its own threshold 85 GTE; Y2 → 80 (AC-P4-02-15)', async () => {
    const y1 = (await app.inject({ url: '/insights/v1/agents/A1001/metrics/PERSISTENCY_Y1', headers: H('A1001') })).json();
    const y2 = (await app.inject({ url: '/insights/v1/agents/A1001/metrics/PERSISTENCY_Y2', headers: H('A1001') })).json();
    expect(y1.threshold).toEqual({ value: 85, comparator: 'GTE' });
    expect(y2.threshold).toEqual({ value: 80, comparator: 'GTE' });
    expect(y1.comparison.change.pp).toBe(2);
    expect(y2.comparison.change.sentiment).toBe('NEGATIVE');
  });

  it('MANPOWER (TEAM) has grouped barComparison with ABS delta chips (AC-P4-02-11/12)', async () => {
    const d = (await app.inject({ url: '/insights/v1/agents/L2001/metrics/MANPOWER?scope=TEAM', headers: H('L2001') })).json();
    expect(d.barComparison.axis.unitCode).toBe('AGENTS');
    expect(d.barComparison.measures).toHaveLength(2);
    const closing = d.barComparison.measures[1];
    expect(closing.points[0].change).toBeUndefined();
    expect(closing.points[1].change.abs.kind).toBe('COUNT');
  });

  it('NEW_RECRUIT_CONTRACTED bars exist in SELF too (v1.2.0 fix)', async () => {
    const d = (await app.inject({ url: '/insights/v1/agents/A1001/metrics/NEW_RECRUIT_CONTRACTED', headers: H('A1001') })).json();
    expect(d.barComparison.measures).toHaveLength(1);
    expect(d.barComparison.measures[0].measureCode).toBeUndefined();
  });

  it('PRODUCTIVITY is DECIMAL with ABS change +0.4 (AC-P4-02-14)', async () => {
    const d = (await app.inject({ url: '/insights/v1/agents/L2001/metrics/PRODUCTIVITY?scope=TEAM', headers: H('L2001') })).json();
    expect(d.primary.collected).toMatchObject({ kind: 'DECIMAL', value: 9.7 });
    expect(d.comparison.change.abs).toMatchObject({ kind: 'DECIMAL', value: 0.4 });
  });

  it('demo agents drive designed dataStates (AC-P4-02-17/18)', async () => {
    const empty = (await app.inject({ url: '/insights/v1/agents/A1002/metrics/CASE_COUNT', headers: H('A1002') })).json();
    const proc = (await app.inject({ url: '/insights/v1/agents/A1003/metrics/CASE_COUNT', headers: H('A1003') })).json();
    expect(empty.dataState).toBe('EMPTY');
    expect(empty.primary).toBeUndefined();
    expect(proc.dataState).toBe('PROCESSING');
  });

  it('unknown metric for the lens → 404 INS-4041 (PTPC under SCHEME)', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics/PTPC?basis=SCHEME', headers: H('A1001') });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('INS-4041');
  });
});

describe('series (S-P4-03)', () => {
  it('yearsBack=0 returns the anchor year alone with Aug–Dec null (AC-P4-03-01)', async () => {
    const s = (await app.inject({ url: '/insights/v1/agents/A1001/metrics/TPC/series?yearsBack=0', headers: H('A1001') })).json();
    expect(s.anchorYear).toBe(2026);
    expect(s.series).toHaveLength(1);
    const pts = s.series[0].points;
    expect(pts).toHaveLength(12);
    expect(pts[0].value.kind).toBe('MONEY');
    expect(pts.slice(7).every((p: any) => p.value === null)).toBe(true);
  });
  it('yearsBack=2 returns 3 years, prior years fully populated; yearsBack=5 → 400', async () => {
    const s = (await app.inject({ url: '/insights/v1/agents/A1001/metrics/TPC/series?yearsBack=2', headers: H('A1001') })).json();
    expect(s.series.map((y: any) => y.year)).toEqual([2026, 2025, 2024]);
    expect(s.series[1].points.every((p: any) => p.value !== null)).toBe(true);
    const bad = await app.inject({ url: '/insights/v1/agents/A1001/metrics/TPC/series?yearsBack=5', headers: H('A1001') });
    expect(bad.statusCode).toBe(400);
  });
  it('PTPC has no history capability → 404', async () => {
    const res = await app.inject({ url: '/insights/v1/agents/A1001/metrics/PTPC/series', headers: H('A1001') });
    expect(res.statusCode).toBe(404);
  });
});

describe('milestones', () => {
  it('returns MDRT_SERIES + STAR_CLUB, scope-invariant (AC-P4-01-12/-20)', async () => {
    const m = (await app.inject({ url: '/insights/v1/agents/L2001/milestones', headers: H('L2001') })).json();
    expect(m.items.map((i: any) => i.programCode)).toEqual(['MDRT_SERIES', 'STAR_CLUB']);
    expect(m.items[0].measures).toHaveLength(3);
    expect(m.items[0].progressPct).toBe(60);
  });
});

describe('definitions & preferences (S-P4-04)', () => {
  it('catalog exposes favourability/changeDisplay/segmentOverrides (v1.3.0)', async () => {
    const c = (await app.inject({ url: '/insights/v1/metric-definitions', headers: H('A1001') })).json();
    expect(c.country).toBe('MY');
    const acs = c.items.find((d: any) => d.metricCode === 'AVERAGE_CASE_SIZE');
    expect(acs.changeDisplay).toBe('ABS');
    const nrc = c.items.find((d: any) => d.metricCode === 'NEW_RECRUIT_CONTRACTED');
    expect(nrc.scopeOverrides.TEAM.category).toBe('PRIORITY');
    const ptpc = c.items.find((d: any) => d.metricCode === 'PTPC');
    expect(ptpc.segmentOverrides.SCHEME.included).toBe(false);
  });

  it('GET defaults → source DEFAULT with TEAM having 9 priority codes', async () => {
    const p = (await app.inject({ url: '/insights/v1/agents/L2001/metric-preferences?scope=TEAM', headers: H('L2001') })).json();
    expect(p.source).toBe('DEFAULT');
    expect(p.priorityMetricCodes).toHaveLength(9);
    expect(p.focusMetricCodes).toEqual(['FYC', 'PERSISTENCY_CY']);
  });

  it('PUT valid reorder+focus saves; GET reflects it (AC-P4-04-03)', async () => {
    const prefs = (await app.inject({ url: '/insights/v1/agents/A1001/metric-preferences', headers: H('A1001') })).json();
    const reordered = [...prefs.priorityMetricCodes].reverse();
    const put = await app.inject({
      method: 'PUT', url: '/insights/v1/agents/A1001/metric-preferences?scope=SELF', headers: H('A1001'),
      payload: { priorityMetricCodes: reordered, focusMetricCodes: ['FYC', 'PERSISTENCY_Y1'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().source).toBe('AGENT');
    const got = (await app.inject({ url: '/insights/v1/agents/A1001/metric-preferences', headers: H('A1001') })).json();
    expect(got.priorityMetricCodes).toEqual(reordered);
    expect(got.focusMetricCodes).toEqual(['FYC', 'PERSISTENCY_Y1']);
  });

  it('PUT with a removed locked metric → 422 INS-4222; unknown code → 422 INS-4224; wrong count → 422 INS-4221 (AC-P4-04-08/09)', async () => {
    const missingLocked = await app.inject({
      method: 'PUT', url: '/insights/v1/agents/A1001/metric-preferences', headers: H('A1001'),
      payload: { priorityMetricCodes: ['TPC', 'PTPC', 'CASE_COUNT', 'FYC'], focusMetricCodes: [] },
    });
    expect(missingLocked.statusCode).toBe(422);
    expect(missingLocked.json().code).toBe('INS-4222');
    const unknown = await app.inject({
      method: 'PUT', url: '/insights/v1/agents/A1001/metric-preferences', headers: H('A1001'),
      payload: { priorityMetricCodes: ['TPC', 'PTPC', 'CASE_COUNT', 'FYP'], focusMetricCodes: ['NOT_A_METRIC'] },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().code).toBe('INS-4224');
    const wrongCount = await app.inject({
      method: 'PUT', url: '/insights/v1/agents/L2001/metric-preferences?scope=TEAM', headers: H('L2001'),
      payload: { priorityMetricCodes: ['TPC'], focusMetricCodes: [] },
    });
    expect(wrongCount.statusCode).toBe(422);
    expect(['INS-4221', 'INS-4222']).toContain(wrongCount.json().code);
  });
});

describe('recommendations (S-P23-01)', () => {
  it('panel present with flags/highlight/insights; feedback POST 204 then round-trips (AC-P23-01-04)', async () => {
    const r1 = (await app.inject({ url: '/insights/v1/agents/A1001/recommendations', headers: H('A1001') })).json();
    expect(r1.panel.flags[0]).toMatchObject({ code: 'PERFORMANCE_DROPS', severity: 'CRITICAL' });
    expect(r1.panel.highlight.goal.progressPct).toBe(76);
    expect(r1.panel.feedback).toBeUndefined();
    const id = r1.panel.recommendationId;
    const post = await app.inject({
      method: 'POST', url: `/insights/v1/agents/A1001/recommendations/${id}/feedback`, headers: H('A1001'),
      payload: { rating: 'UP' },
    });
    expect(post.statusCode).toBe(204);
    const r2 = (await app.inject({ url: '/insights/v1/agents/A1001/recommendations', headers: H('A1001') })).json();
    expect(r2.panel.feedback.rating).toBe('UP');
    const bad = await app.inject({
      method: 'POST', url: `/insights/v1/agents/A1001/recommendations/nope/feedback`, headers: H('A1001'),
      payload: { rating: 'DOWN' },
    });
    expect(bad.statusCode).toBe(404);
  });
});
