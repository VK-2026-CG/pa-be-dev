import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson, getStatus } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF team drilldown (S-P4-07)', () => {
  it('omitted basis lists every hierarchy level with its own hierarchyBasis (AC-P4-07-06)', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    expect(vm.filters.scope).toBe('TEAM');
    expect(vm.filters.teamView).toBe('DIRECT');
    expect(vm.filters.basis).toBeUndefined();
    expect(vm.members).toHaveLength(10); // AM mock: 4 UMs with teams + 6 agents
    const levels = new Set(vm.members.map((m: any) => m.hierarchyBasis));
    expect(levels).toEqual(new Set(['UM', 'AGENT']));
    for (const m of vm.members) {
      if (m.hierarchyBasis === 'UM') expect(m.directReportCount).toBeGreaterThan(0);
      else expect(m.directReportCount).toBeUndefined();
    }
    const marcus = vm.members.find((m: any) => m.displayName === 'Marcus Lee');
    expect(marcus).toMatchObject({
      hierarchyBasis: 'UM', badges: ['MDRT', 'PWP'], goalStatus: 'SET', directReportCount: 24, photoUrl: '/mock-avatars/marcus-lee.png',
      tpc: { kind: 'MONEY', amount: '172000.00', currency: 'MYR' },
      ptpc: { kind: 'MONEY', amount: '198000.00', currency: 'MYR' },
      nav: { route: 'insights/performance', params: { subjectAgentId: marcus.agentId } },
    });
  });

  it('explicit basis still restricts the list to that level (AC-P4-07-02 regression)', async () => {
    const vm = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?basis=UM`);
    expect(vm.filters.basis).toBe('UM');
    expect(vm.members.every((m: any) => m.hierarchyBasis === 'UM')).toBe(true);
  });

  it('sortBy orders members descending with name tie-break; default TPC; invalid → 400 (AC-P4-07-07)', async () => {
    const byTpc = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    expect(byTpc.filters.sortBy).toBe('TPC');
    const tpc = byTpc.members.map((m: any) => Number(m.tpc.amount));
    expect(tpc).toEqual([...tpc].sort((a, b) => b - a));
    expect(byTpc.members[0].displayName).toBe('Marcus Lee');
    const byPtpc = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?sortBy=PTPC`);
    const ptpc = byPtpc.members.map((m: any) => Number(m.ptpc.amount));
    expect(ptpc).toEqual([...ptpc].sort((a, b) => b - a));
    for (let i = 1; i < byPtpc.members.length; i++) {
      if (ptpc[i] === ptpc[i - 1]) expect(byPtpc.members[i - 1].displayName.localeCompare(byPtpc.members[i].displayName)).toBeLessThanOrEqual(0);
    }
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?sortBy=FYP`)).toBe(400);
  });

  it('badges filter is ANY-match and KPI tiles follow the filtered set; VIOLET/unknown → 400 (AC-P4-07-08)', async () => {
    const all = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    expect(all.summary.map((t: any) => t.metricCode)).toEqual(['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE']);
    expect(all.summary.map((t: any) => t.valueType)).toEqual(['COUNT', 'PERCENT', 'DECIMAL', 'MONEY']);
    expect(all.filterOptions.badgeGroups.map((g: any) => g.groupCode)).toEqual(['MDRT', 'PRUWEALTH_PLANNER', 'PV', 'ROOKIE']);
    const filtered = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?badges=MDRT,TOT,PV`);
    expect(filtered.filters.badges).toEqual(['MDRT', 'TOT', 'PV']);
    expect(filtered.members.length).toBeGreaterThan(0);
    expect(filtered.members.length).toBeLessThan(all.members.length);
    for (const m of filtered.members) expect(m.badges.some((b: string) => ['MDRT', 'TOT', 'PV'].includes(b))).toBe(true);
    expect(filtered.summary[0].value.value).toBeLessThan(all.summary[0].value.value);
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?badges=VIOLET`)).toBe(400);
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?badges=GOLD`)).toBe(400);
  });

  it('parentAgentId lists a downline member\'s team with parent and no summary; outside downline → 403 BFF-4033 (AC-P4-07-09)', async () => {
    const all = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown`);
    const marcus = all.members.find((m: any) => m.displayName === 'Marcus Lee');
    const sub = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?parentAgentId=${marcus.agentId}`);
    expect(sub.parent).toMatchObject({ agentId: marcus.agentId, displayName: 'Marcus Lee', directReportCount: 24 });
    expect(sub.filters.parentAgentId).toBe(marcus.agentId);
    expect(sub.members).toHaveLength(24);
    expect(sub.summary).toBeUndefined();
    const scoped = await getJson(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?parentAgentId=${marcus.agentId}&query=omar`);
    expect(scoped.members.map((m: any) => m.displayName)).toEqual(['Omar Hassan']);
    // P3 (L2001) only sees its DIRECT team — the P2 leader's other UM is outside it.
    const res = await app.inject({ method: 'GET', url: `${BFF}/performance/team-drilldown?parentAgentId=${marcus.agentId}`, headers: { 'x-persona': 'LEADER_P3' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BFF-4033');
    expect(await getStatus(app, 'LEADER_P2', `${BFF}/performance/team-drilldown?parentAgentId=NOPE01`)).toBe(403);
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
    // performanceBasis=SCHEME excludes PTPC (catalog.ts segmentOverrides, OQ-20 placeholder) — only TPC remains.
    expect(vm.selectedMember.metrics).toHaveLength(1);
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
