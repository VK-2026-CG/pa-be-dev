/**
 * DEVELOPMENT-ONLY seed: a nested Team Drilldown hierarchy (AM → UM → UM1 → UM2 → agents)
 * under a synthetic AM, in `pa_performance_PAMB-dev`.
 *
 *   npx tsx scripts/seed-team-hierarchy-mock.ts                 dry run: prints the plan, writes nothing
 *   npx tsx scripts/seed-team-hierarchy-mock.ts --apply         insert (insert-only, one transaction)
 *   npx tsx scripts/seed-team-hierarchy-mock.ts --remove        dry run of the removal
 *   npx tsx scripts/seed-team-hierarchy-mock.ts --remove --apply
 *   --no-metrics                                                hierarchy snapshots only
 *
 * Safety (same posture as `db:import:performance`): dry-run unless `--apply`; insert-only — an
 * existing document with a different body aborts the run, nothing is overwritten; development/test
 * profile only; the target database must be the named `-dev` PAMB database. Everything written is
 * reachable by the reserved `MCK` ID prefix, and `--remove` deletes only that (bounded filters).
 * It never modifies a real AM, agent or metric row, and it does not provision or alter schemas.
 *
 * `my_agent_hierarchy` is otherwise an independently managed read-only source (see
 * docs/team-drilldown-hierarchy-source.md); this script is the one deliberate dev-only exception.
 */
import { closeDb, getPerformanceDb } from '../src/db/mongo.js';
import { PERFORMANCE_DATABASES, PERFORMANCE_HIERARCHY_COLLECTION } from '../src/config/performance.js';
import { PERFORMANCE_COLLECTIONS, performanceProfile, type PerformanceCollection } from '../src/data/performance-profile.js';
import { documentFingerprint, inspectImport, normalizeMockRecord, type MockImport } from '../src/data/performance-import.js';
import type { Db, Document } from 'mongodb';
import {
  MOCK_AM_ID, MOCK_PREFIX, MOCK_TAG, buildMockTree, cloneMetricRow, descendantCount, flatten, hasCardFigures, hierarchyDocument,
  metricPlan, scaleFor, type MockNode,
} from './team-hierarchy-mock.js';

const REAL_ONLY = { $not: { $regex: `^${MOCK_PREFIX}` } };
const NEWEST = { 'period.year': -1, 'period.month': -1, id: -1 } as const;
const monthKey = (row: Document) => `${Number(row.period?.year)}-${Number(row.period?.month)}`;

interface Template {
  agentId: string; asOnDate: Date; rows: Partial<Record<PerformanceCollection, Record<string, Document>>>;
  /** Real AMs passed over before this one, with the reason (no values). */
  skipped: string[];
}

/**
 * The first real AM (by ID) whose newest-period rows cover everything the AM plan needs, in one
 * period, with non-zero card figures (`hasCardFigures`), and whose rows survive the same schema
 * normalization the insert applies (dev data has rows with drifted types, e.g. `asOnMonthDay`
 * stored as a Date or string; those would be rejected at insert time).
 */
async function findTemplate(db: Db): Promise<Template> {
  const plan = metricPlan(buildMockTree());
  const ams = await db.collection(PERFORMANCE_HIERARCHY_COLLECTION)
    .find({ 'displayRows.tier': 'AM', 'hierarchy.leaderId': REAL_ONLY }, { projection: { 'hierarchy.leaderId': 1, asOnDate: 1 } })
    .sort({ 'hierarchy.leaderId': 1 }).toArray();
  const skipped: string[] = [];
  for (const am of ams) {
    const agentId = String(am.hierarchy.leaderId);
    const rows: Template['rows'] = {};
    const months = new Set<string>();
    let reason: string | undefined;
    for (const [name, aggregations] of Object.entries(plan) as Array<[PerformanceCollection, string[]]>) {
      for (const aggregation of aggregations) {
        const query: Document = { agentId, entity: 'PAMB', agentAggregation: aggregation };
        if (name === 'my_production') query.caseStatus = 'Collected';
        const [row] = await db.collection(name).find(query).sort(NEWEST).limit(1).toArray();
        if (!row) { reason = `no newest ${name}/${aggregation} row`; break; }
        (rows[name] ??= {})[aggregation] = row;
        months.add(monthKey(row));
      }
      if (reason) break;
    }
    if (!reason && months.size !== 1) reason = 'newest rows span different periods';
    if (!reason && !hasCardFigures(rows.my_production?.Personal)) reason = 'zero TPC/PTPC card figures';
    if (!reason) {
      for (const [name, byAggregation] of Object.entries(rows) as Array<[PerformanceCollection, Record<string, Document>]>) {
        for (const row of Object.values(byAggregation)) {
          try { normalizeMockRecord(name, cloneMetricRow(name, row, agentId, { agentId: `${MOCK_PREFIX}PROBE`, tier: 'Agent' }, { factor: 1 })); }
          catch (error) { reason = `${name} row fails the source schema (${String((error as Error).message)})`; }
        }
      }
    }
    if (reason) { skipped.push(`${agentId}: ${reason}`); continue; }
    return { agentId, asOnDate: am.asOnDate instanceof Date ? am.asOnDate : new Date(am.asOnDate), rows, skipped };
  }
  throw new Error(`No real AM can be cloned (${skipped.join('; ')}); re-run with --no-metrics`);
}

/** Read-only conflict preflight for the hierarchy snapshots (same rule as `inspectImport`). */
async function inspectHierarchy(db: Db, docs: Document[]): Promise<{ pending: Document[]; unchanged: number }> {
  const coll = db.collection(PERFORMANCE_HIERARCHY_COLLECTION);
  const pending: Document[] = [];
  for (const doc of docs) {
    const existing = await coll.find({ $or: [{ _id: doc._id }, { 'hierarchy.leaderId': doc.hierarchy.leaderId }] }, { promoteValues: false }).toArray();
    if (!existing.length) pending.push(doc);
    else if (existing.length !== 1 || documentFingerprint(existing[0]) !== documentFingerprint(doc)) {
      throw new Error(`Conflicting existing hierarchy snapshot for ${String(doc.hierarchy.leaderId)}; seed aborted`);
    }
  }
  return { pending, unchanged: docs.length - pending.length };
}

function printTree(node: MockNode, depth = 0, out: string[] = []): string[] {
  const team = node.reports.length ? `  [${node.reports.length} direct, ${descendantCount(node)} below]` : '';
  out.push(`${'  '.repeat(depth)}${depth ? '└─ ' : ''}${node.agentId} (${node.tier})${team}`);
  node.reports.forEach(report => printTree(report, depth + 1, out));
  return out;
}

async function seed(db: Db, apply: boolean, withMetrics: boolean) {
  const root = buildMockTree();
  const members = flatten(root);
  const probe = await db.collection(PERFORMANCE_HIERARCHY_COLLECTION)
    .find({ 'displayRows.tier': 'AM', 'hierarchy.leaderId': REAL_ONLY }, { projection: { asOnDate: 1 } }).sort({ asOnDate: -1 }).limit(1).toArray();
  const template = withMetrics ? await findTemplate(db) : undefined;
  const asOnDate: Date = template?.asOnDate ?? (probe[0]?.asOnDate instanceof Date ? probe[0].asOnDate : new Date(Date.UTC(2026, 8, 28)));

  const hierarchy = members.map(member => hierarchyDocument(member, root.agentId, asOnDate));
  const hierarchyPlan = await inspectHierarchy(db, hierarchy);

  const rows: MockImport = { my_production: [], my_mapa: [], my_persistency: [] };
  if (template) {
    members.forEach((member, index) => {
      for (const [name, aggregations] of Object.entries(metricPlan(member)) as Array<[PerformanceCollection, string[]]>) {
        for (const aggregation of aggregations) {
          const source = template.rows[name]![aggregation]!;
          const manpower = member.tier === 'Agent' ? undefined : Math.max(1, descendantCount(member));
          rows[name].push(normalizeMockRecord(name, cloneMetricRow(name, source, template.agentId, member, { factor: scaleFor(index), ...(manpower !== undefined ? { manpower } : {}) })));
        }
      }
    });
  }
  const metricPlanCounts = await inspectImport(db, rows);

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', database: db.databaseName, syntheticAm: MOCK_AM_ID,
    cloneTemplate: template ? `real AM ${template.agentId} (newest period, per-aggregation rows)` : 'none (--no-metrics)',
    ...(template?.skipped.length ? { templateSkipped: template.skipped } : {}),
    inserts: { [PERFORMANCE_HIERARCHY_COLLECTION]: hierarchyPlan.pending.length, ...Object.fromEntries(PERFORMANCE_COLLECTIONS.map(name => [name, metricPlanCounts.pending[name].length])) },
    unchangedAlreadyPresent: { [PERFORMANCE_HIERARCHY_COLLECTION]: hierarchyPlan.unchanged, ...Object.fromEntries(PERFORMANCE_COLLECTIONS.map(name => [name, metricPlanCounts.counts[name]!.unchanged])) },
  }, null, 2));
  console.log(`\nTree (${members.length} members):\n${printTree(root).join('\n')}`);
  if (!apply) { console.log('\nDry run — nothing written. Re-run with --apply to insert.'); return; }

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      if (hierarchyPlan.pending.length) await db.collection(PERFORMANCE_HIERARCHY_COLLECTION).insertMany(hierarchyPlan.pending, { session, ordered: true });
      for (const name of PERFORMANCE_COLLECTIONS) {
        if (metricPlanCounts.pending[name].length) await db.collection(name).insertMany(metricPlanCounts.pending[name], { session, ordered: true });
      }
    });
  } finally { await session.endSession(); }
  console.log(`\nInserted. Sign in as ${MOCK_AM_ID} (VITE_PERFORMANCE_AGENT_ID=${MOCK_AM_ID}) to open My Team. Undo with: --remove --apply`);
}

const hierarchyFilter = { 'mock.set': MOCK_TAG, 'hierarchy.leaderId': { $regex: `^${MOCK_PREFIX}` } };
const metricFilter = { agentId: { $regex: `^${MOCK_PREFIX}` }, id: { $regex: `^${MOCK_PREFIX}` } };

async function remove(db: Db, apply: boolean) {
  const counts: Record<string, number> = { [PERFORMANCE_HIERARCHY_COLLECTION]: await db.collection(PERFORMANCE_HIERARCHY_COLLECTION).countDocuments(hierarchyFilter) };
  for (const name of PERFORMANCE_COLLECTIONS) counts[name] = await db.collection(name).countDocuments(metricFilter);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', action: 'remove', database: db.databaseName, matched: counts }, null, 2));
  if (!apply) { console.log('\nDry run — nothing deleted. Re-run with --apply to delete exactly these.'); return; }
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection(PERFORMANCE_HIERARCHY_COLLECTION).deleteMany(hierarchyFilter, { session });
      for (const name of PERFORMANCE_COLLECTIONS) await db.collection(name).deleteMany(metricFilter, { session });
    });
  } finally { await session.endSession(); }
  console.log('\nRemoved.');
}

async function main() {
  performanceProfile(); // fail closed (development/test, MY) before opening a connection
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const db = await getPerformanceDb('PAMB');
  if (db.databaseName !== PERFORMANCE_DATABASES.PAMB || !db.databaseName.endsWith('-dev')) throw new Error('Seed target must be the named PAMB development database');
  if (args.includes('--remove')) await remove(db, apply);
  else await seed(db, apply, !args.includes('--no-metrics'));
}

main().catch(error => {
  // Driver errors can echo documents/hosts; never dump raw error objects.
  console.error(error?.name?.startsWith('Mongo') ? `Mongo seed failed (${error.codeName ?? error.name}); no document logged` : String(error?.message ?? error));
  process.exitCode = 1;
}).finally(closeDb);
