/**
 * DEVELOPMENT-ONLY nested Team Drilldown fixture for Performance source mode:
 * AM → UM → UM1 → UM2 → agents, as `my_agent_hierarchy` snapshots plus cloned
 * metric rows. Pure builders only — `seed-team-hierarchy-mock.ts` does the I/O.
 *
 * Why it exists: every real AM snapshot in the dev database is flat (ID-only
 * reportees, none with a snapshot of its own), so Team Drilldown never shows a
 * manager and the team icon / nested drill-down can't be exercised.
 *
 * Everything here is addressable by the reserved `MCK` ID prefix (and, for
 * hierarchy snapshots, `mock.set`), so removal never touches a real record.
 */
import { createHash } from 'node:crypto';
import { BSON, ObjectId, type Document } from 'mongodb';
import type { PerformanceCollection } from '../src/data/performance-profile.js';

export const MOCK_TAG = 'team-drilldown-nested';
export const MOCK_PREFIX = 'MCK';
export const MOCK_AM_ID = 'MCKAM001';

export type MockTier = 'AM' | 'UM' | 'UM1' | 'UM2' | 'Agent';
export interface MockNode { agentId: string; tier: MockTier; reports: MockNode[] }

/**
 * 19 members. The AM sees 5 direct reports (2 managers + 3 agents); each manager
 * drills down through UM → UM1 → UM2 → agents, so team icons appear at every
 * manager level and every level has agents to open a self view from.
 */
export function buildMockTree(): MockNode {
  let seq = 0;
  const agents = (count: number): MockNode[] => Array.from({ length: count }, () => (
    { agentId: `${MOCK_PREFIX}AG${String(++seq).padStart(3, '0')}`, tier: 'Agent' as const, reports: [] }));
  const manager = (agentId: string, tier: MockTier, reports: MockNode[]): MockNode => ({ agentId, tier, reports });
  // Array elements evaluate left to right, so agent IDs are stable run to run.
  return manager(MOCK_AM_ID, 'AM', [
    manager('MCKUM01', 'UM', [
      manager('MCKUM101', 'UM1', [manager('MCKUM201', 'UM2', agents(3)), ...agents(2)]),
      ...agents(2),
    ]),
    manager('MCKUM02', 'UM', [
      manager('MCKUM102', 'UM1', [manager('MCKUM202', 'UM2', agents(2))]),
    ]),
    ...agents(3),
  ]);
}

/** Parents before children. */
export function flatten(node: MockNode): MockNode[] {
  return [node, ...node.reports.flatMap(flatten)];
}
export const descendantCount = (node: MockNode): number => flatten(node).length - 1;
export const isManager = (node: MockNode): boolean => node.reports.length > 0;

/** Deterministic ObjectId so a re-run is a no-op instead of a duplicate. */
export function deterministicObjectId(seed: string): { $oid: string } {
  return { $oid: createHash('sha1').update(seed).digest('hex').slice(0, 24) };
}

/**
 * Snapshot shape mirrors the real documents (same fields and types). Like the real
 * data, an AM snapshot lists only its reportees while UM/agent snapshots list the
 * leader itself first (`reportIdsOf` strips it). Names are plain mock labels — the
 * app never projects them.
 */
export function hierarchyDocument(node: MockNode, rootId: string, asOnDate: Date): Document {
  const reportIds = node.reports.map(report => report.agentId);
  const label = `Mock ${node.tier} ${node.agentId}`;
  return {
    _id: ObjectId.createFromHexString(deterministicObjectId(`hierarchy:${node.agentId}`).$oid),
    id: node.agentId,
    entity: 'PAMB',
    hierarchy: { leaderId: node.agentId, leaderName: label, level: 0, rootId },
    displayRows: {
      profileId: node.agentId, fullName: label, entity: 'PAMB', agentType: 'HYBRID', profileNumber: null,
      tier: node.tier, classification: '', hasSubordinates: null, headcount: null, metrics: { scheme: {}, combined: {} },
    },
    subtree: { headcount: null, scopeProfileIds: node.tier === 'AM' ? reportIds : [node.agentId, ...reportIds] },
    asOnDate,
    audit: { createdAt: asOnDate, updatedAt: asOnDate, schemaVersion: 1 },
    mock: { set: MOCK_TAG },
  };
}

/**
 * Which newest-period rows (collection → aggregations) a member gets, cloned from a
 * real AM. Managers get their own and their direct unit's figures (viewing a manager
 * is the TEAM/DIRECT dashboard); agents only need Personal rows. Only the AM carries
 * Group rows (the Group toggle is P2-only).
 */
export function metricPlan(node: MockNode): Partial<Record<PerformanceCollection, string[]>> {
  if (node.tier === 'AM') {
    return { my_production: ['Personal', 'DirectUnit', 'Group'], my_mapa: ['DirectUnit', 'Group'], my_persistency: ['Personal', 'DirectUnit', 'Group'] };
  }
  if (isManager(node)) {
    return { my_production: ['Personal', 'DirectUnit'], my_mapa: ['DirectUnit'], my_persistency: ['Personal', 'DirectUnit'] };
  }
  return { my_production: ['Personal'], my_persistency: ['Personal'] };
}

/**
 * A template is only useful if its Personal production row carries the figures the member cards read
 * (TPC/PTPC `withoutRepricing`, YTD): cloning zeros would show every card as TPC 0 / PTPC 0.
 */
export function hasCardFigures(personalProduction: Document | undefined): boolean {
  const positive = (path: string) => {
    const value = path.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), personalProduction);
    return typeof value === 'number' && value > 0;
  };
  return positive('ptd.tpc.withoutRepricing.ytd') && positive('ptd.ptpc.withoutRepricing.ytd');
}

/** Descending 1.00 → ~0.46 down the tree so TPC/PTPC sorting has something to sort. */
export const scaleFor = (index: number): number => Math.max(0.4, Number((1 - index * 0.03).toFixed(2)));

function scaleNumbers(value: unknown, factor: number): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? Math.round(value * factor) : Number((value * factor).toFixed(2));
  if (Array.isArray(value)) return value.map(item => scaleNumbers(item, factor));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scaleNumbers(v, factor)]));
  return value;
}

/**
 * Clones one real metric row for a mock member as normalizer input (EJSON-relaxed, so
 * `normalizeMockRecord` re-types and schema-validates it). Production figures (money and
 * counts) are scaled per member; persistency and MAPA ratios are copied as they are,
 * except MAPA manpower, which is set to the member's real mock headcount.
 */
export function cloneMetricRow(
  collection: PerformanceCollection,
  template: Document,
  templateAgentId: string,
  member: { agentId: string; tier: MockTier },
  options: { factor: number; manpower?: number },
): Record<string, unknown> {
  const row = BSON.EJSON.serialize(template, { relaxed: true }) as Record<string, unknown>;
  const templateTier = typeof template.agentTier === 'string' ? template.agentTier : undefined;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && value.includes(templateAgentId)) row[key] = value.replaceAll(templateAgentId, member.agentId);
  }
  row.agentId = member.agentId;
  if ('agentTier' in row) row.agentTier = member.tier;
  if (templateTier && typeof row.id === 'string') row.id = row.id.replace(`_${templateTier}_`, `_${member.tier}_`);
  if ('agentRefererAgentId' in row) row.agentRefererAgentId = null;
  row._id = deterministicObjectId(`${collection}:${String(row.id)}`);
  if (collection === 'my_production') {
    for (const key of ['snapshot', 'ptd']) if (row[key] !== undefined) row[key] = scaleNumbers(row[key], options.factor);
  }
  if (collection === 'my_mapa' && options.manpower !== undefined) {
    const total = options.manpower;
    const active = Math.max(1, Math.round(total * 0.8));
    const set = (path: string[], value: number) => {
      let at = row as Record<string, unknown>;
      for (const key of path.slice(0, -1)) { const next = at[key]; if (!next || typeof next !== 'object') return; at = next as Record<string, unknown>; }
      if (path[path.length - 1]! in at) at[path[path.length - 1]!] = value;
    };
    set(['snapshot', 'manpower', 'total'], total);
    set(['snapshot', 'manpower', 'active'], active);
    for (const period of ['mtd', 'qtd', 'ytd']) set(['ptd', 'manpowerTotal', period], total);
  }
  return row;
}
