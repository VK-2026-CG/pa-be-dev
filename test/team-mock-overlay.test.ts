import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource, type DataSource } from '../src/data/source.js';
import type { AgentRecord } from '../src/data/registry.js';

process.env.NODE_ENV = 'test';
process.env.INSIGHTS_DATA_SOURCE = 'memory';
process.env.MONGODB_URI = ''; // isolated test fixture only
const memory = await createSource();

/** Stand-in for the Mongo source: one allowlisted P2 identity, own data only, no hierarchy. */
const ME: AgentRecord = { agentId: '1000369', tenant: 'MY', level: 'P2', name: 'Development mock identity' };
const real = new Proxy({ kind: 'performance', ownIdentityOnly: true, findAgent: (id: string) => (id === ME.agentId ? ME : undefined) } as unknown as DataSource, {
  get(target, prop) {
    if (prop in target) return (target as any)[prop];
    if (prop === 'listTeamMembers') return async () => ({ asOfDate: '2025-05-31', items: [], summary: [{ metricCode: 'MANPOWER' }] });
    if (typeof (memory as any)[prop] !== 'function') return undefined;
    // Delegate reads for the real identity to the memory engine, tagged so tests can tell them apart.
    return (...args: any[]) => (memory as any)[prop](...args);
  },
});
const app = buildApp(real);
const as = (id: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-agent-id': id, 'x-tenant': 'MY' } });

describe('Team Drilldown in Mongo mode with no hierarchy source', () => {
  it('does not return synthetic members or KPI values', async () => {
    const res = await as(ME.agentId, '/api/bff/v1/performance/team-drilldown');
    expect(res.statusCode).toBe(200);
    const vm = res.json();
    expect(vm.members).toEqual([]);
    expect(vm.summary.every((entry: { value?: unknown }) => entry.value === undefined)).toBe(true);
  });

  it('does not resolve synthetic team members', async () => {
    const res = await as(ME.agentId, '/api/bff/v1/performance/dashboard?subjectAgentId=KCM00101');
    expect([403, 404]).toContain(res.statusCode);
  });

  it('mock members can never be used as a login identity', async () => {
    expect((await as('KCM00101', '/api/bff/v1/performance/team-drilldown')).statusCode).toBe(401);
    expect((await as('L3001', '/api/bff/v1/performance/dashboard')).statusCode).toBe(401);
  });
});
