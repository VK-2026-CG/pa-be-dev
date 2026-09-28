import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson, getStatus } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

async function memberId(name: string): Promise<string> {
  const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
  return vm.members.find((m: any) => m.displayName === name).agentId;
}

describe('BFF dashboard viewing mode (S-P4-01 2.1.0, SPEC-2026-004)', () => {
  it('subjectAgentId is for leaders and downline members only (AC-P4-01-82)', async () => {
    const omar = await memberId('Omar Hassan');
    expect(await getStatus(app, 'AGENT_P4', `${BFF}/performance/dashboard?subjectAgentId=${omar}`)).toBe(403);
    const res = await app.inject({ method: 'GET', url: `${BFF}/performance/dashboard?subjectAgentId=${omar}`, headers: { 'x-persona': 'LEADER_P3' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BFF-4033');
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/dashboard?subjectAgentId=NOPE01`)).toBe(403);
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/dashboard?subjectAgentId=${omar}`)).toBe(200);
    // Whole downline for P2: a member of a UM's team is viewable.
    const all = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    const marcus = all.members.find((m: any) => m.displayName === 'Marcus Lee');
    const sub = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?parentAgentId=${marcus.agentId}`);
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/dashboard?subjectAgentId=${sub.members[0].agentId}`)).toBe(200);
  });

  it('scope follows the member role and ignores query scope/teamView (AC-P4-01-83)', async () => {
    const agent = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=TEAM&teamView=GROUP&subjectAgentId=${await memberId('Omar Hassan')}`);
    expect(agent.viewing).toMatchObject({ scope: 'SELF', readOnly: true, exitNav: { route: 'insights/team-drilldown' } });
    expect(agent.viewing.member.displayName).toBe('Omar Hassan');
    expect(agent.filters.scope).toBe('SELF');
    const um = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?subjectAgentId=${await memberId('Marcus Lee')}&period=QTD`);
    expect(um.viewing.scope).toBe('TEAM');
    expect(um.filters).toMatchObject({ scope: 'TEAM', teamView: 'DIRECT', period: 'QTD' });
  });

  it('viewing is read-only (AC-P4-01-84)', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?subjectAgentId=${await memberId('Marcus Lee')}`);
    expect(vm.scopeSwitcher).toBeUndefined();
    expect(vm.quickLinks.map((l: any) => l.id)).toEqual(['COMP_BEN']);
    expect(vm.moreActions.map((a: any) => a.id)).toEqual(['HISTORICAL_DATA']);
    expect(vm.focusMetrics.addEnabled).toBe(false);
    expect(vm.milestones.addEnabled).toBe(false);
    expect(vm.milestones.setGoalEnabled).toBe(false);
    expect(vm.filters.teamViewToggleVisible).toBe(false);
  });

  it('dashboard without subjectAgentId is unchanged', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=TEAM&teamView=DIRECT`);
    expect(vm.viewing).toBeUndefined();
    expect(vm.scopeSwitcher).toBeDefined();
  });
});
