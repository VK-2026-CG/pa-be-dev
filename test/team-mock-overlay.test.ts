import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource, type DataSource } from '../src/data/source.js';
import { TeamDrilldownMockOverlay, teamDrilldownMockEnabled } from '../src/data/team-mock-overlay.js';
import type { AgentRecord } from '../src/data/registry.js';

process.env.MONGODB_URI = ''; // the "real" side below is a stub; no database
const memory = await createSource();

/** Stand-in for the Mongo source: one allowlisted P2 identity, own data only, no hierarchy. */
const ME: AgentRecord = { agentId: '1000369', tenant: 'MY', level: 'P2', name: 'Development mock identity' };
const real = new Proxy({ kind: 'performance', ownIdentityOnly: true, findAgent: (id: string) => (id === ME.agentId ? ME : undefined) } as unknown as DataSource, {
  get(target, prop) {
    if (prop in target) return (target as any)[prop];
    if (typeof (memory as any)[prop] !== 'function') return undefined;
    // Delegate reads for the real identity to the memory engine, tagged so tests can tell them apart.
    return (...args: any[]) => (memory as any)[prop](...args);
  },
});
const app = buildApp(new TeamDrilldownMockOverlay(real, memory));
const as = (id: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-agent-id': id, 'x-tenant': 'MY' } });

describe('Team Drilldown mock overlay in Mongo mode (SPEC-2026-004 D-P4-07-06)', () => {
  it('serves the mock AM team (10 members, photos, subteams) for the real development identity', async () => {
    const res = await as(ME.agentId, '/api/bff/v1/performance/team-drilldown');
    expect(res.statusCode).toBe(200);
    const vm = res.json();
    expect(vm.members).toHaveLength(10);
    expect(vm.members[0]).toMatchObject({ displayName: 'Marcus Lee', directReportCount: 24, photoUrl: '/mock-avatars/marcus-lee.png' });
    expect(vm.summary[0].value).toBeDefined();
    const sub = await as(ME.agentId, `/api/bff/v1/performance/team-drilldown?parentAgentId=${vm.members[0].agentId}`);
    expect(sub.json().members).toHaveLength(24);
  });

  it('viewing a mock member composes from the memory engine', async () => {
    const res = await as(ME.agentId, '/api/bff/v1/performance/dashboard?subjectAgentId=KCM00101');
    expect(res.statusCode).toBe(200);
    expect(res.json().viewing).toMatchObject({ scope: 'TEAM', member: { displayName: 'Marcus Lee' } });
  });

  it('mock members can never be used as a login identity', async () => {
    expect((await as('KCM00101', '/api/bff/v1/performance/team-drilldown')).statusCode).toBe(401);
    expect((await as('L3001', '/api/bff/v1/performance/dashboard')).statusCode).toBe(401);
  });

  it('is opt-in and refused in production', () => {
    expect(teamDrilldownMockEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(teamDrilldownMockEnabled({ NODE_ENV: 'development', INSIGHTS_TEAM_DRILLDOWN_MOCK: 'true' })).toBe(true);
    expect(() => teamDrilldownMockEnabled({ NODE_ENV: 'production', INSIGHTS_TEAM_DRILLDOWN_MOCK: 'true' })).toThrow(/development-only/);
  });
});
