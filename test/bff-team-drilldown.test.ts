import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson, getStatus } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF team drilldown (S-P4-07)', () => {
  it('leader gets members for default basis/view', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    expect(vm.filters.scope).toBe('TEAM');
    expect(vm.filters.teamView).toBe('DIRECT');
    expect(vm.filters.basis).toBe('AGENT');
    expect(Array.isArray(vm.members)).toBe(true);
    expect(vm.members.length).toBeGreaterThan(0);
  });

  it('basis allow-list rejects unknown values (AC-P4-07-02)', async () => {
    const status = await getStatus(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?basis=CUSTOM`);
    expect(status).toBe(400);
  });

  it('GROUP is forbidden for P3 leader (AC-P4-07-01)', async () => {
    const status = await getStatus(app, 'LEADER_P3', `${BFF}/performance/team-drilldown?teamView=GROUP`);
    expect(status).toBe(403);
  });

  it('non-leader is forbidden', async () => {
    const status = await getStatus(app, 'AGENT_P4', `${BFF}/performance/team-drilldown`);
    expect(status).toBe(403);
  });

  it('search is case-insensitive on id/displayName (AC-P4-07-03)', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?basis=AGENT&query=aisyAH`);
    expect(vm.filters.search).toBe('aisyAH');
    expect(vm.members).toHaveLength(1);
    expect(vm.members[0].displayName).toBe('Aisyah Rahman');
  });

  it('selected-member preview preserves requested performance dimensions (AC-P4-07-04)', async () => {
    const vm = await getJson(
      app,
      'LEADER_P2',
      `${BFF}/performance/team-drilldown?basis=AGENT&period=QTD&businessLine=INSURANCE&performanceBasis=SCHEME&teamView=DIRECT&selectedAgentId=A1001`,
    );
    expect(vm.selectedMember.context).toMatchObject({
      period: 'QTD',
      businessLine: 'INSURANCE',
      basis: 'SCHEME',
      scope: 'TEAM',
      teamView: 'DIRECT',
    });
    expect(vm.selectedMember.metrics).toHaveLength(2);
    expect(vm.selectedMember.metrics[0].nav.route).toBe('insights/metric-detail');
    expect(vm.selectedMember.metrics[0].nav.params).toMatchObject({
      period: 'QTD',
      businessLine: 'INSURANCE',
      basis: 'SCHEME',
      scope: 'TEAM',
      teamView: 'DIRECT',
    });
  });
});
