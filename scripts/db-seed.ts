/**
 * db-seed — acts as the "data pipeline" for the mock stage: materializes the
 * deterministic in-memory engine into the C1 collections, so Mongo mode
 * serves byte-identical data to memory mode (all 24 integration tests and
 * the app's 29-check smoke stay meaningful against Atlas).
 *
 *   npm run db:seed          upsert everything (idempotent)
 *   npm run db:seed -- --dry-run   materialize + print counts, no connection
 *
 * Document shape: unique key + lineage fields exactly per mongodb.md; the
 * API-shaped body produced by the engine sits under `payload` (and
 * `detailPayload` on snapshots). A production pipeline would flatten values
 * to Decimal128 per C1 — this seeder keeps the mock honest and swappable.
 */
import { COLL, closeDb, getDb } from '../src/db/mongo.js';
import { AGENTS } from '../src/data/registry.js';
import { CATALOG, effectiveCatalog } from '../src/data/catalog.js';
import {
  ANCHOR_YEAR, AS_OF_DATE, metricDetail, metricList, metricSeries, milestones, type Lens,
} from '../src/data/values.js';
import { recommendations } from '../src/data/recommendations.js';
import type { Basis, BusinessLine, PeriodType, Scope, TeamView } from '../src/types.js';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import { Decimal128 } from 'mongodb';
import { createHash } from 'node:crypto';

const DRY = process.argv.includes('--dry-run');
const NOW = new Date();
const BATCH = `seed-${NOW.toISOString().slice(0, 19)}`;
const asOf = new Date(`${AS_OF_DATE}T00:00:00Z`);
const lineage = { asOfDate: asOf, asOfDateStr: AS_OF_DATE, computedAt: NOW, sourceBatchId: BATCH };
const AGENT_BATCH = 'agent-master-2026-07-27-v1';
const PRODUCTION_BATCH = 'production-2026-07-27-v1';
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PERIODS: PeriodType[] = ['MTD', 'QTD', 'YTD'];
const BLS: BusinessLine[] = ['ALL', 'INSURANCE', 'TAKAFUL'];
const BASES: Basis[] = ['STANDARD', 'SCHEME'];

/** Scope/teamView tuples an agent's pipelines would materialize.
 *  P4 agents: SELF only. P3: TEAM/DIRECT (GROUP is forbidden → never
 *  materialized, mirroring INS-4031). P2: DIRECT + GROUP. */
function scopeTuples(level: 'P2' | 'P3' | 'P4'): Array<{ scope: Scope; teamView: TeamView | '-' }> {
  const t: Array<{ scope: Scope; teamView: TeamView | '-' }> = [{ scope: 'SELF', teamView: '-' }];
  if (level !== 'P4') t.push({ scope: 'TEAM', teamView: 'DIRECT' });
  if (level === 'P2') t.push({ scope: 'TEAM', teamView: 'GROUP' });
  return t;
}

function periodKey(p: PeriodType): Document {
  // asOf 2026-07-27 → Q3 / July (matches the engine's fixed clock).
  const base: Document = { type: p, year: ANCHOR_YEAR, quarter: null, month: null };
  if (p === 'QTD') base.quarter = 3;
  if (p === 'MTD') base.month = 7;
  return base;
}

async function main() {
  const snapOps: AnyBulkWriteOperation<Document>[] = [];
  const seriesOps: AnyBulkWriteOperation<Document>[] = [];
  const mileOps: AnyBulkWriteOperation<Document>[] = [];
  const defOps: AnyBulkWriteOperation<Document>[] = [];
  const recoOps: AnyBulkWriteOperation<Document>[] = [];

  for (const agent of AGENTS) {
    for (const { scope, teamView } of scopeTuples(agent.level)) {
      const tvParam: TeamView | undefined = teamView === '-' ? undefined : teamView;
      for (const basis of BASES) {
        const catalog = effectiveCatalog(scope, basis);
        for (const businessLine of BLS) {
          /* ── metric_snapshots: one doc per metric per lens ── */
          for (const period of PERIODS) {
            const l: Lens = { period, businessLine, basis, scope, ...(tvParam ? { teamView: tvParam } : {}) };
            const list = metricList(l, 'ALL');
            for (const item of list.items) {
              const def = catalog.find((d) => d.metricCode === item.metricCode);
              const detail = metricDetail(item.metricCode, l, agent.demoDataState);
              snapOps.push({
                updateOne: {
                  filter: {
                    tenant: agent.tenant, agentId: agent.agentId, scope, teamView,
                    metricCode: item.metricCode, 'period.type': period, 'period.year': ANCHOR_YEAR,
                    'period.quarter': period === 'QTD' ? 3 : null, 'period.month': period === 'MTD' ? 7 : null,
                    businessLine, basis,
                  },
                  update: {
                    $set: {
                      period: periodKey(period), valueType: item.valueType ?? 'MONEY',
                      order: def?.effOrder ?? 999, context: list.context,
                      payload: item, ...(detail ? { detailPayload: detail } : {}),
                      ...lineage,
                    },
                  },
                  upsert: true,
                },
              });
            }
          }
          /* ── metric_series: one doc per metric-year (history capability) ── */
          const lSeries: Lens = { period: 'YTD', businessLine, basis, scope, ...(tvParam ? { teamView: tvParam } : {}) };
          for (const def of catalog) {
            const s = metricSeries(def.metricCode, lSeries, ANCHOR_YEAR, 2);
            if (!s) continue;
            for (const yr of s.series) {
              seriesOps.push({
                updateOne: {
                  filter: {
                    tenant: agent.tenant, agentId: agent.agentId, scope, teamView,
                    metricCode: def.metricCode, businessLine, basis, year: yr.year,
                  },
                  update: { $set: { valueType: s.valueType, points: yr.points, ...lineage } },
                  upsert: true,
                },
              });
            }
          }
        }
      }
    }

    /* ── milestone_progress: personal, scope/lens-invariant (AC-P4-01-12) ── */
    const m = milestones();
    m.items.forEach((item, i) => {
      mileOps.push({
        updateOne: {
          filter: {
            tenant: agent.tenant, agentId: agent.agentId,
            programCode: item.programCode, variant: item.variant, cycleYear: item.cycleYear,
          },
          update: { $set: { priority: true, order: i, payload: item, ...lineage } },
          upsert: true,
        },
      });
    });

    /* ── recommendations: one doc per scope (TTL 30 days) ── */
    for (const scope of ['SELF', 'TEAM'] as Scope[]) {
      if (scope === 'TEAM' && agent.level === 'P4') continue;
      const payload = recommendations(agent.agentId, scope);
      const recoId = payload.panel?.recommendationId ?? 'reco-seed';
      recoOps.push({
        updateOne: {
          filter: { tenant: agent.tenant, agentId: agent.agentId, scope, context: 'PERFORMANCE' },
          update: {
            $set: {
              recommendationId: recoId, payload,
              generatedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * 86400_000),
            },
          },
          upsert: true,
        },
      });
    }
  }

  /* ── reference data (tenant-level) ── */
  for (const def of CATALOG) {
    defOps.push({
      updateOne: {
        filter: { tenant: 'MY', metricCode: def.metricCode },
        update: { $set: { definition: def, active: true, updatedAt: NOW } },
        upsert: true,
      },
    });
  }
  const milestoneDefs = milestones().items.map((item) => ({
    updateOne: {
      filter: { tenant: 'MY', programCode: item.programCode },
      update: {
        $set: {
          tiers: [
            { code: item.currentTier.code, order: 1, targets: item.measures.map((x) => ({ measureCode: x.measureCode, target: x.target })) },
            ...(item.nextTier ? [{ code: item.nextTier.code, order: 2, targets: item.measures.map((x) => ({ measureCode: x.measureCode, target: x.target })) }] : []),
          ],
        },
      },
      upsert: true,
    },
  })) as AnyBulkWriteOperation<Document>[];

  const summary = {
    metric_snapshots: snapOps.length, metric_series: seriesOps.length,
    milestone_progress: mileOps.length, metric_definitions: defOps.length,
    milestone_definitions: milestoneDefs.length, recommendations: recoOps.length,
    mock_agent_master: AGENTS.length, mock_production_transactions: AGENTS.length * 12,
    source_snapshots: 2, agent_snapshot_staging: AGENTS.length,
    production_snapshot_staging: AGENTS.length * 12,
  };
  console.log('Materialized document upserts:', summary);

  if (DRY) { console.log('--dry-run: not connecting. Done.'); return; }

  const db = await getDb();
  const write = async (coll: string, ops: AnyBulkWriteOperation<Document>[]) => {
    if (!ops.length) return;
    const res = await db.collection(coll).bulkWrite(ops, { ordered: false });
    console.log(`  ${coll}: upserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  };
  await write(COLL.snapshots, snapOps);
  await write(COLL.series, seriesOps);
  await write(COLL.milestones, mileOps);
  await write(COLL.metricDefs, defOps);
  await write(COLL.milestoneDefs, milestoneDefs);
  await write(COLL.recommendations, recoOps);
  const regions = ['CENTRAL', 'NORTH', 'SOUTH'];
  const mockAgentOps: AnyBulkWriteOperation<Document>[] = AGENTS.map((agent, index) => ({ updateOne: {
    filter: { tenant: agent.tenant, agentId: agent.agentId },
    update: { $set: { tenant: agent.tenant, agentId: agent.agentId, agentCode: agent.agentId, name: agent.name, rank: agent.level, region: regions[index % regions.length], channel: index % 2 ? 'TAKAFUL' : 'AGENCY', appointmentDate: new Date(`20${18 + index}-01-15T00:00:00Z`), leaderId: agent.level === 'P4' ? 'L2001' : agent.level === 'P3' ? 'L3001' : null, active: true, sourceBatchId: BATCH } }, upsert: true,
  } }));
  const productionOps: AnyBulkWriteOperation<Document>[] = [];
  AGENTS.forEach((agent, agentIndex) => { for (let month = 1; month <= 12; month++) { const transactionId = `${agent.agentId}-2026-${String(month).padStart(2, '0')}`; productionOps.push({ updateOne: {
    filter: { tenant: agent.tenant, transactionId },
    update: { $set: { tenant: agent.tenant, transactionId, agentId: agent.agentId, policyNumber: `POL-${agent.agentId}-${String(month).padStart(3, '0')}`, transactionDate: new Date(`2026-${String(month).padStart(2, '0')}-15T00:00:00Z`), businessLine: month % 3 === 0 ? 'TAKAFUL' : 'INSURANCE', productType: month % 2 === 0 ? 'INVESTMENT_LINKED' : 'TRADITIONAL', fyp: 1000 + agentIndex * 250 + month * 100, api: 800 + agentIndex * 200 + month * 80, caseCount: 1 + ((agentIndex + month) % 4), sourceBatchId: BATCH } }, upsert: true,
  } }); } });
  await write(COLL.mockAgents, mockAgentOps); await write(COLL.mockProduction, productionOps);
  // Canonical, privacy-safe full-snapshot staging mirrors the existing agent IDs.
  // Names and all prohibited identity/contact/demographic fields are deliberately omitted.
  const businessDate = new Date('2026-07-27T00:00:00.000Z');
  const agentRows = AGENTS.map((agent, index) => ({
    tenant: agent.tenant, sourceBatchId: AGENT_BATCH, businessDate,
    participantId: agent.agentId, agentCode: agent.agentId, producerClass: agent.level,
    region: regions[index % regions.length], channel: index % 2 ? 'TAKAFUL' : 'AGENCY',
    appointmentDate: new Date(`20${18 + index}-01-15T00:00:00Z`),
    uplineParticipantId: agent.level === 'P4' ? 'L2001' : agent.level === 'P3' ? 'L3001' : null,
    active: true, mappingVersion: 'MY-0.1.0', validationState: 'VALID', rejectionCodes: [], sourceRowNumber: index + 1,
  })).map((row) => ({ ...row, sourceRowHash: sha256(row) }));
  const productionRows = AGENTS.flatMap((agent, agentIndex) => Array.from({ length: 12 }, (_, offset) => {
    const month = offset + 1; const transactionId = `${agent.agentId}-2026-${String(month).padStart(2, '0')}`;
    const row = { tenant: agent.tenant, sourceBatchId: PRODUCTION_BATCH, businessDate,
      transactionId, participantId: agent.agentId, policyRef: sha256(`POL-${agent.agentId}-${month}`).slice(0, 24),
      transactionDate: new Date(`2026-${String(month).padStart(2, '0')}-15T00:00:00Z`),
      businessLine: month % 3 === 0 ? 'TAKAFUL' : 'INSURANCE', productType: month % 2 === 0 ? 'INVESTMENT_LINKED' : 'TRADITIONAL',
      fyp: Decimal128.fromString(String(1000 + agentIndex * 250 + month * 100)), api: Decimal128.fromString(String(800 + agentIndex * 200 + month * 80)),
      caseCount: 1 + ((agentIndex + month) % 4), mappingVersion: 'MY-0.1.0', validationState: 'VALID', rejectionCodes: [], sourceRowNumber: agentIndex * 12 + month };
    return { ...row, sourceRowHash: sha256({ ...row, fyp: row.fyp.toString(), api: row.api.toString() }) };
  }));
  await write(COLL.agentStaging, agentRows.map((row) => ({ updateOne: { filter: { tenant: row.tenant, sourceBatchId: row.sourceBatchId, participantId: row.participantId }, update: { $set: row }, upsert: true } })));
  await write(COLL.productionStaging, productionRows.map((row) => ({ updateOne: { filter: { tenant: row.tenant, sourceBatchId: row.sourceBatchId, transactionId: row.transactionId }, update: { $set: row }, upsert: true } })));
  const receivedAt = new Date('2026-07-27T01:00:00.000Z');
  await write(COLL.sourceSnapshots, [
    { updateOne: { filter: { tenant: 'MY', sourceType: 'AGENT_MASTER', sourceBatchId: AGENT_BATCH }, update: { $setOnInsert: { tenant: 'MY', sourceBatchId: AGENT_BATCH, sourceType: 'AGENT_MASTER', businessDate, schemaVersion: '0.1.0', objectUri: `mongodb://${COLL.agentStaging}/${AGENT_BATCH}`, sha256: sha256(agentRows), rowCount: agentRows.length, receivedAt, status: 'VALID', qualityResults: [], validatedAt: receivedAt } }, upsert: true } },
    { updateOne: { filter: { tenant: 'MY', sourceType: 'PRODUCTION', sourceBatchId: PRODUCTION_BATCH }, update: { $setOnInsert: { tenant: 'MY', sourceBatchId: PRODUCTION_BATCH, sourceType: 'PRODUCTION', businessDate, schemaVersion: '0.1.0', objectUri: `mongodb://${COLL.productionStaging}/${PRODUCTION_BATCH}`, sha256: sha256(productionRows.map((row) => ({ ...row, fyp: row.fyp.toString(), api: row.api.toString() }))), rowCount: productionRows.length, receivedAt, status: 'VALID', qualityResults: [], validatedAt: receivedAt } }, upsert: true } },
  ]);
  await closeDb();
  console.log('db:seed done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
