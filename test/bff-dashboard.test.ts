import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson, getStatus, metricCodes } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF dashboard (S-P4-01)', () => {
  it('SELF: 4 priority cards, PTPC hides goal (AC-P4-01-06)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=SELF`);
    expect(metricCodes(d.priorityMetrics)).toEqual(['TPC', 'PTPC', 'CASE_COUNT', 'FYP']);
    expect(d.priorityMetrics[0].showGoal).toBe(true);
    expect(d.priorityMetrics[1].showGoal).toBe(false);
    expect(d.priorityMetrics[0].value.amount).toBe('100000.00');
  });

  it('SELF: focus row simple cards + AI panel + milestones', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=SELF`);
    expect(metricCodes(d.focusMetrics.items)).toEqual(['FYC', 'PERSISTENCY_CY']);
    expect(d.recommendations.panel.highlight.goal.progressPct).toBe(76);
    expect(d.milestones.items).toHaveLength(2);
  });

  it('TEAM DIRECT: 8 cards, Group toggle visible for P2 (AC-P4-01-16)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=TEAM`);
    expect(d.priorityMetrics).toHaveLength(8);
    expect(d.priorityMetrics.map((c: any) => c.metricCode)).not.toContain('NEW_RECRUIT_CONTRACTED');
    expect(d.filters.teamView).toBe('DIRECT');
    expect(d.filters.teamViewToggleVisible).toBe(true);
    expect(d.filters.basisToggleVisible).toBe(false);
  });

  it('TEAM GROUP (P2): values scale up', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=TEAM&teamView=GROUP`);
    expect(d.filters.teamView).toBe('GROUP');
    expect(Number(d.priorityMetrics[0].value.amount)).toBeGreaterThan(300000);
  });

  it('SCHEME re-composition (D-13): [TPC,FYP,CASE_COUNT], goals SET', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/dashboard?scope=SELF&basis=SCHEME`);
    expect(metricCodes(d.priorityMetrics)).toEqual(['TPC', 'FYP', 'CASE_COUNT']);
    expect(d.priorityMetrics[0].goal.state).toBe('SET');
  });
});

describe('entitlement guards mirror D-14', () => {
  it('P3 + GROUP → 403 (AC-P4-01-24)', async () => {
    const status = await getStatus(app, 'LEADER_P3', `${BFF}/performance/dashboard?scope=TEAM&teamView=GROUP`);
    expect(status).toBe(403);
  });

  it('P4 + TEAM → 403', async () => {
    const status = await getStatus(app, 'AGENT_P4', `${BFF}/performance/dashboard?scope=TEAM`);
    expect(status).toBe(403);
  });
});
