import { describe, expect, it } from 'vitest';
import type { Db, Document } from 'mongodb';
import { PerformanceSource } from '../src/data/performance-source.js';
import { PERFORMANCE_DATABASES } from '../src/data/performance-profile.js';
import type { AgentRecord } from '../src/data/registry.js';
import type { Lens } from '../src/data/values.js';
import {
  MOCK_AM_ID, MOCK_PREFIX, MOCK_TAG, buildMockTree, cloneMetricRow, descendantCount, flatten, hasCardFigures, hierarchyDocument, metricPlan, scaleFor,
} from '../scripts/team-hierarchy-mock.js';

const asOn = new Date('2026-09-28T00:00:00Z');
const lens: Lens = { period: 'YTD', businessLine: 'INSURANCE', basis: 'STANDARD', scope: 'TEAM', teamView: 'DIRECT' };

/** Minimal Db double: equality / $in / $or and array-contains, sort and limit — enough for hierarchy reads. */
function fakeDb(name: string, data: Record<string, Document[]>): Db {
  const get = (row: Document, key: string) => key.split('.').reduce((v, part) => v?.[part], row);
  const matches = (row: Document, query: Document): boolean => Object.entries(query).every(([key, value]) => {
    if (key === '$or') return (value as Document[]).some(q => matches(row, q));
    if (value && typeof value === 'object' && '$in' in value) return (value.$in as unknown[]).map(String).includes(String(get(row, key)));
    const field = get(row, key);
    if (Array.isArray(field)) return field.map(String).includes(String(value));
    return String(field) === String(value);
  });
  return { databaseName: name, collection: (collection: string) => ({
    find: (query: Document) => {
      let rows = (data[collection] ?? []).filter(row => matches(row, query));
      const cursor = {
        sort: () => cursor,
        limit: (n: number) => { rows = rows.slice(0, n); return cursor; },
        toArray: async () => rows,
      };
      return cursor;
    },
  }) } as unknown as Db;
}

const tree = buildMockTree();
const members = flatten(tree);
const snapshots = members.map(member => hierarchyDocument(member, tree.agentId, asOn));
const agentFor = (agentId: string, level: AgentRecord['level']): AgentRecord => ({ agentId, tenant: 'MY', level, name: agentId });
const source = new PerformanceSource({
  PAMB: fakeDb(PERFORMANCE_DATABASES.PAMB, { my_agent_hierarchy: snapshots }),
  PBTB: fakeDb(PERFORMANCE_DATABASES.PBTB, {}),
}, new Map());
const list = (caller: AgentRecord, parentMemberAgentId?: string) =>
  source.listTeamMembers(caller, { teamView: 'DIRECT', sortBy: 'TPC', lens, ...(parentMemberAgentId ? { parentMemberAgentId } : {}) });

describe('nested Team Drilldown mock hierarchy (dev seed)', () => {
  it('is a 19-member AM → UM → UM1 → UM2 → agent tree on reserved IDs', () => {
    expect(members).toHaveLength(19);
    expect(new Set(members.map(m => m.agentId)).size).toBe(19);
    expect(members.every(m => m.agentId.startsWith(MOCK_PREFIX))).toBe(true);
    expect(members.filter(m => m.tier !== 'Agent').map(m => m.tier)).toEqual(['AM', 'UM', 'UM1', 'UM2', 'UM', 'UM1', 'UM2']);
    expect(members.every(m => m.tier === 'Agent' || m.reports.length > 0)).toBe(true);
    expect(descendantCount(tree)).toBe(18);
  });

  it('writes snapshots shaped like the real ones: AM lists reportees only, managers/agents list themselves first', () => {
    const byId = new Map(snapshots.map(s => [s.hierarchy.leaderId as string, s]));
    expect(byId.get(MOCK_AM_ID)!.subtree.scopeProfileIds).toHaveLength(5);
    expect(byId.get(MOCK_AM_ID)!.subtree.scopeProfileIds).not.toContain(MOCK_AM_ID);
    for (const member of members.filter(m => m.tier !== 'AM')) {
      expect(byId.get(member.agentId)!.subtree.scopeProfileIds[0]).toBe(member.agentId);
    }
    for (const snapshot of snapshots) {
      expect(snapshot.mock).toEqual({ set: MOCK_TAG });
      expect(snapshot.asOnDate).toBeInstanceOf(Date);
      expect(snapshot.audit.schemaVersion).toBe(1);
      // every referenced reportee is a node of this tree: no dangling IDs, no cycles
      for (const id of snapshot.subtree.scopeProfileIds as string[]) expect(members.some(m => m.agentId === id)).toBe(true);
    }
    // deterministic _id: rebuilding the snapshots yields the same keys, so a re-run is a no-op
    expect(snapshots.map(s => String(s._id))).toEqual(flatten(buildMockTree()).map(m => String(hierarchyDocument(m, tree.agentId, asOn)._id)));
    expect(new Set(snapshots.map(s => String(s._id))).size).toBe(19);
  });

  it('the AM resolves as P2 and sees UMs with team counts plus its direct agents', async () => {
    expect(await source.resolveIdentity(MOCK_AM_ID)).toMatchObject({ agentId: MOCK_AM_ID, level: 'P2' });
    const root = await list(agentFor(MOCK_AM_ID, 'P2'));
    expect(root!.items.map(m => m.agentId).sort()).toEqual(['MCKAG010', 'MCKAG011', 'MCKAG012', 'MCKUM01', 'MCKUM02']);
    const um = root!.items.find(m => m.agentId === 'MCKUM01')!;
    expect(um).toMatchObject({ hierarchyBasis: 'UM', directReportCount: 3 });
    expect(root!.items.find(m => m.agentId === 'MCKAG010')!.directReportCount).toBeUndefined();
  });

  it('drills down level by level: UM → UM1 → UM2 → agents', async () => {
    const am = agentFor(MOCK_AM_ID, 'P2');
    const um = await list(am, 'MCKUM01');
    expect(um!.parent).toMatchObject({ agentId: 'MCKUM01', directReportCount: 3 });
    expect(um!.items.map(m => m.agentId).sort()).toEqual(['MCKAG006', 'MCKAG007', 'MCKUM101']);
    const um1 = await list(am, 'MCKUM101');
    expect(um1!.items.find(m => m.agentId === 'MCKUM201')).toMatchObject({ directReportCount: 3 });
    expect(um1!.items).toHaveLength(3);
    const um2 = await list(am, 'MCKUM201');
    expect(um2!.items.map(m => m.agentId)).toEqual(['MCKAG001', 'MCKAG002', 'MCKAG003']);
    expect(um2!.items.every(m => m.hierarchyBasis === 'AGENT' && m.directReportCount === undefined)).toBe(true);
  });

  it('a second branch reaches UM2 agents too, and an unknown parent is not visible', async () => {
    const am = agentFor(MOCK_AM_ID, 'P2');
    expect((await list(am, 'MCKUM202'))!.items.map(m => m.agentId)).toEqual(['MCKAG008', 'MCKAG009']);
    expect(await list(am, 'MCKAG001')).toMatchObject({ items: [] }); // an agent has no team
    expect(await list(am, 'NOT-IN-TREE')).toBeUndefined();
  });

  it('D-14 still holds: a UM caller sees its direct team only, not deeper levels', async () => {
    const um = agentFor('MCKUM01', 'P3');
    expect(await source.resolveIdentity('MCKUM01')).toMatchObject({ level: 'P3' });
    expect((await list(um))!.items.map(m => m.agentId).sort()).toEqual(['MCKAG006', 'MCKAG007', 'MCKUM101']);
    expect(await list(um, 'MCKUM101')).toBeDefined(); // a direct report's team
    expect(await list(um, 'MCKUM201')).toBeUndefined(); // two levels down
  });
});

describe('metric row cloning for the mock members', () => {
  const production: Document = {
    _id: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, id: '1037892_Personal_AM_Collected_202507_Non-scheme', agentKey: '1037892_Personal', agentId: '1037892',
    agentTier: 'AM', agentAggregation: 'Personal', agentRefererAgentId: 'REAL-REFERER', entity: 'PAMB', caseStatus: 'Collected',
    period: { year: 2025, month: 7, yyyymm: '202507', quarter: 'Q3' },
    snapshot: { fyp: { total: 1001 }, tpc: { withRepricing: { total: 2500.5 } } }, ptd: { fyp: { ytd: 5000 } },
  };
  const agent = { agentId: 'MCKAG001', tier: 'Agent' as const };

  it('rewrites identity, tier and keys, so no real agent ID leaks into the clone', () => {
    const row = cloneMetricRow('my_production', production, '1037892', agent, { factor: 0.5 });
    expect(row).toMatchObject({ id: 'MCKAG001_Personal_Agent_Collected_202507_Non-scheme', agentKey: 'MCKAG001_Personal', agentId: 'MCKAG001', agentTier: 'Agent', agentRefererAgentId: null });
    expect(JSON.stringify(row)).not.toContain('1037892');
    expect(JSON.stringify(row)).not.toContain('REAL-REFERER');
  });

  it('uses a deterministic _id so re-running is a no-op, and different per row', () => {
    const a = cloneMetricRow('my_production', production, '1037892', agent, { factor: 1 });
    const b = cloneMetricRow('my_production', production, '1037892', agent, { factor: 1 });
    const other = cloneMetricRow('my_production', production, '1037892', { agentId: 'MCKAG002', tier: 'Agent' }, { factor: 1 });
    expect(a._id).toEqual(b._id);
    expect(a._id).not.toEqual(other._id);
    expect(a._id).toMatchObject({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) });
  });

  it('scales production money/counts (integers stay integers) and leaves the template untouched', () => {
    const row = cloneMetricRow('my_production', production, '1037892', agent, { factor: 0.5 }) as Document;
    expect(row.snapshot.fyp.total).toBe(501);
    expect(row.snapshot.tpc.withRepricing.total).toBe(1250.25);
    expect(row.ptd.fyp.ytd).toBe(2500);
    expect(production.snapshot.fyp.total).toBe(1001);
  });

  it('copies persistency as is, and only sets MAPA manpower where the fields exist', () => {
    const persistency: Document = { id: '1037892_Personal_AM_202507', agentId: '1037892', agentTier: 'AM', metrics: { ytd: { currentYearPersistency: 0.93 } } };
    expect((cloneMetricRow('my_persistency', persistency, '1037892', agent, { factor: 0.4 }) as Document).metrics.ytd.currentYearPersistency).toBe(0.93);
    const mapa: Document = { id: '1037892_DirectUnit_AM_2025-07', agentId: '1037892', agentTier: 'AM', snapshot: { manpower: { total: 71, active: 60 } }, ptd: { manpowerTotal: { ytd: 71 }, activityRatio: { ytd: 80 } } };
    const row = cloneMetricRow('my_mapa', mapa, '1037892', { agentId: 'MCKUM01', tier: 'UM' }, { factor: 1, manpower: 8 }) as Document;
    expect(row.snapshot.manpower).toEqual({ total: 8, active: 6 });
    expect(row.ptd.manpowerTotal).toEqual({ ytd: 8 });
    expect(row.ptd.activityRatio).toEqual({ ytd: 80 });
    expect(row.ptd.manpowerTotal.mtd).toBeUndefined(); // not invented where the template has no such field
  });

  it('only accepts a template whose Personal row has non-zero card figures (zeros would clone to TPC 0 / PTPC 0)', () => {
    const row = (tpc: unknown, ptpc: unknown): Document => ({ ptd: { tpc: { withoutRepricing: { ytd: tpc } }, ptpc: { withoutRepricing: { ytd: ptpc } } } });
    expect(hasCardFigures(row(4538.76, 2329.38))).toBe(true);
    expect(hasCardFigures(row(0, 2329.38))).toBe(false);
    expect(hasCardFigures(row(4538.76, 0))).toBe(false);
    expect(hasCardFigures(row(null, null))).toBe(false);
    expect(hasCardFigures(undefined)).toBe(false);
    expect(hasCardFigures({ ptd: { tpc: { withRepricing: { ytd: 5 } } } })).toBe(false); // the cards read withoutRepricing
  });

  it('plans the rows each tier needs: agents Personal only, UMs add DirectUnit, only the AM adds Group', () => {
    const tiers = new Map(members.map(m => [m.tier + (m.reports.length ? '' : '-leaf'), metricPlan(m)]));
    expect(tiers.get('Agent-leaf')).toEqual({ my_production: ['Personal'], my_persistency: ['Personal'] });
    expect(tiers.get('UM')).toEqual({ my_production: ['Personal', 'DirectUnit'], my_mapa: ['DirectUnit'], my_persistency: ['Personal', 'DirectUnit'] });
    expect(JSON.stringify(tiers.get('AM'))).toContain('Group');
    const total = members.reduce((sum, m) => sum + Object.values(metricPlan(m)).flat().length, 0);
    expect(total).toBe(62);
    expect(scaleFor(0)).toBe(1);
    expect(scaleFor(18)).toBeGreaterThanOrEqual(0.4);
  });
});
