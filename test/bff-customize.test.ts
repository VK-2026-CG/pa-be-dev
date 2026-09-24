import { beforeEach, describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { _resetPreferences } from '../src/data/preferences.js';
import { BFF, getJson, putJson } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

beforeEach(() => _resetPreferences());

/** Preferences are process-wide mutable state — these must not interleave. */
describe('BFF customize (S-P4-04)', () => {
  it('GET: locked priority + focus list (AC-P4-04-01)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/customize?scope=SELF`);
    expect(d.priority.every((i: any) => i.locked)).toBe(true);
    expect(d.constraints.priority).toEqual({ min: 4, max: 4, editable: false });
  });

  it('PUT: saved order + focus round-trips (AC-P4-04-03)', async () => {
    const { status, body } = await putJson(app, 'AGENT_P4', `${BFF}/performance/customize?scope=SELF`, {
      priorityMetricCodes: ['FYP', 'TPC', 'PTPC', 'CASE_COUNT'],
      focusMetricCodes: ['FYC', 'PERSISTENCY_Y1'],
    });
    expect(status).toBe(200);
    expect(body.priority.map((i: any) => i.metricCode)).toEqual(['FYP', 'TPC', 'PTPC', 'CASE_COUNT']);
    expect(body.focus.filter((i: any) => i.selected).map((i: any) => i.metricCode))
      .toEqual(['FYC', 'PERSISTENCY_Y1']);
  });

  it('dashboard honors saved priority order after PUT', async () => {
    await putJson(app, 'AGENT_P4', `${BFF}/performance/customize?scope=SELF`, {
      priorityMetricCodes: ['FYP', 'TPC', 'PTPC', 'CASE_COUNT'],
      focusMetricCodes: ['FYC', 'PERSISTENCY_Y1'],
    });
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/dashboard?scope=SELF`);
    expect(d.priorityMetrics.map((c: any) => c.metricCode)).toEqual(['FYP', 'TPC', 'PTPC', 'CASE_COUNT']);
  });

  it('TEAM: GET priority set is fully locked and round-trips through PUT with a new focus pick (AC-P4-04-01/03)', async () => {
    const d = await getJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=TEAM`);
    expect(d.constraints.priority).toEqual({ min: 8, max: 8, editable: false });
    expect(d.priority).toHaveLength(8);
    expect(d.priority.every((i: any) => i.locked)).toBe(true);

    const focus = d.focus.filter((i: any) => i.selected).map((i: any) => i.metricCode);
    const extra = d.focus.find((i: any) => !i.selected)?.metricCode;
    const { status, body } = await putJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=TEAM`, {
      priorityMetricCodes: d.priority.map((i: any) => i.metricCode),
      focusMetricCodes: extra ? [...focus, extra] : focus,
    });
    expect(status).toBe(200);
    if (extra) expect(body.focus.find((i: any) => i.metricCode === extra)?.selected).toBe(true);
  });

  it('NEW_RECRUIT_CONTRACTED is an Other Focus Metric at TEAM too, independent of the SELF selection', async () => {
    const self = await getJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=SELF`);
    const selfSave = await putJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=SELF`, {
      priorityMetricCodes: self.priority.map((i: any) => i.metricCode),
      focusMetricCodes: [...self.focus.filter((i: any) => i.selected).map((i: any) => i.metricCode), 'NEW_RECRUIT_CONTRACTED'],
    });
    expect(selfSave.status).toBe(200);

    const team = await getJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=TEAM`);
    expect(team.priority.map((i: any) => i.metricCode)).not.toContain('NEW_RECRUIT_CONTRACTED');
    const nrc = team.focus.find((i: any) => i.metricCode === 'NEW_RECRUIT_CONTRACTED');
    expect(nrc).toMatchObject({ selected: false, locked: false });

    const teamSave = await putJson(app, 'LEADER_P2', `${BFF}/performance/customize?scope=TEAM`, {
      priorityMetricCodes: team.priority.map((i: any) => i.metricCode),
      focusMetricCodes: [...team.focus.filter((i: any) => i.selected).map((i: any) => i.metricCode), 'NEW_RECRUIT_CONTRACTED'],
    });
    expect(teamSave.status).toBe(200);
    expect(teamSave.body.focus.find((i: any) => i.metricCode === 'NEW_RECRUIT_CONTRACTED')?.selected).toBe(true);
  });

  it('PUT: locked-metric removal → 422 INS-4222 (AC-P4-04-08)', async () => {
    const { status, body } = await putJson(app, 'AGENT_P4', `${BFF}/performance/customize?scope=SELF`, {
      priorityMetricCodes: ['TPC', 'PTPC', 'CASE_COUNT', 'FYC'],
      focusMetricCodes: [],
    });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('INS-4222');
  });
});
