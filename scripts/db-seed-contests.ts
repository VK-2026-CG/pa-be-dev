/**
 * Materialize a deterministic published contest and agent results from the
 * existing Mongo agent/production collections. Source records are read-only;
 * only contest-domain projections are upserted.
 */
import { createHash } from 'node:crypto';
import { Decimal128, type Document } from 'mongodb';
import { closeDb, COLL, getContestDb, getDb } from '../src/db/mongo.js';

const TENANT = process.env.CONTEST_SEED_TENANT ?? 'MY';
const BUSINESS_DATE = new Date('2026-07-27T23:59:59.999Z');
const BUSINESS_DATE_WIRE = '2026-07-27';
const CONTEST_ID = 'contest_synthetic_2026';
const VERSION_ID = 'version_synthetic_2026_v1';
const RUN_ID = 'run_synthetic_20260727';
const AGENT_BATCH = 'agent-master-2026-07-27-v1';
const PRODUCTION_BATCH = 'production-2026-07-27-v1';
const CREATED_AT = new Date('2026-07-27T02:00:00.000Z');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decimal = (value: number) => Decimal128.fromString(String(value));

async function main(): Promise<void> {
  const sourceDb = await getDb();
  const contestDb = await getContestDb();
  const agents = await sourceDb.collection(COLL.mockAgents).find(
    { tenant: TENANT, active: true },
    { projection: { _id: 0, tenant: 1, agentId: 1, agentCode: 1, rank: 1, region: 1, channel: 1, leaderId: 1, active: 1 } },
  ).sort({ agentId: 1 }).toArray();
  if (!agents.length) throw new Error(`No active agents found in ${COLL.mockAgents} for tenant ${TENANT}; run npm run db:seed first`);

  const production = await sourceDb.collection(COLL.mockProduction).aggregate<Document>([
    { $match: { tenant: TENANT, agentId: { $in: agents.map((agent) => agent.agentId) }, transactionDate: { $lte: BUSINESS_DATE } } },
    { $group: { _id: '$agentId', fyp: { $sum: '$fyp' }, api: { $sum: '$api' }, caseCount: { $sum: '$caseCount' } } },
  ]).toArray();
  const totals = new Map(production.map((row) => [String(row._id), row]));
  const configuration = {
    basics: { code: 'SYNTH2026', nameKey: 'contest.synthetic.2026', country: TENANT, timezone: 'Asia/Kuala_Lumpur', campaignStart: '2026-01-01', campaignEnd: '2026-12-31' },
    audience: { source: COLL.mockAgents, active: true },
    qualification: { categoryCode: 'ALL_ACTIVE_AGENTS', metricCode: 'FYP', operator: 'GTE', value: '0' },
    calculation: { source: COLL.mockProduction, mode: 'CAMPAIGN_TO_DATE', metrics: ['FYP', 'API', 'CASE_COUNT'] },
    rewards: { tiers: [] },
    governance: { synthetic: true },
    sourceCitations: [],
  };
  const checksum = hash(configuration);
  const sourceLineage = { agentMasterBatchId: AGENT_BATCH, productionBatchId: PRODUCTION_BATCH };
  const contest = { tenant: TENANT, contestId: CONTEST_ID, code: 'SYNTH2026', nameKey: 'contest.synthetic.2026', country: TENANT, timezone: 'Asia/Kuala_Lumpur', ownerRef: 'SYSTEM_SEED', status: 'ACTIVE', latestVersionId: VERSION_ID, publishedVersionId: VERSION_ID, archived: false, revision: 1, campaignStart: '2026-01-01', campaignEnd: '2026-12-31', audienceCodes: ['ALL_ACTIVE_AGENTS'], ruleCount: 1, createdAt: CREATED_AT, updatedAt: CREATED_AT };
  const version = { tenant: TENANT, contestId: CONTEST_ID, versionId: VERSION_ID, revision: 1, displayVersion: '1.0', status: 'PUBLISHED', configuration, checksum, createdBy: 'SYSTEM_SEED', createdAt: CREATED_AT, updatedAt: CREATED_AT, submittedAt: CREATED_AT, approvedAt: CREATED_AT, publishedAt: CREATED_AT };
  const run = { tenant: TENANT, runId: RUN_ID, businessDate: BUSINESS_DATE_WIRE, status: 'PUBLISHED', contestIds: [CONTEST_ID], sourceLineage, reconciliation: { eligible: agents.length, calculated: agents.length, succeeded: agents.length, failed: 0, quarantined: 0 }, createdAt: CREATED_AT, publishedAt: CREATED_AT, engineVersion: 'synthetic-1.0.0', mappingVersion: 'MY-0.1.0' };

  await contestDb.collection(COLL.contests).updateOne({ tenant: TENANT, contestId: CONTEST_ID }, { $set: contest }, { upsert: true });
  await contestDb.collection(COLL.contestVersions).updateOne({ tenant: TENANT, versionId: VERSION_ID }, { $set: version }, { upsert: true });
  await contestDb.collection(COLL.calculationRuns).updateOne({ tenant: TENANT, runId: RUN_ID }, { $set: run }, { upsert: true });

  for (const agent of agents) {
    const values = totals.get(String(agent.agentId)) ?? { fyp: 0, api: 0, caseCount: 0 };
    const fyp = Number(values.fyp ?? 0); const api = Number(values.api ?? 0); const caseCount = Number(values.caseCount ?? 0);
    const categoryResult = {
      categoryCode: 'ALL_ACTIVE_AGENTS', evaluationPeriodCode: 'CAMPAIGN_TO_DATE', qualificationStatus: 'QUALIFIED',
      cumulativeMetrics: [
        { metricCode: 'FYP', kind: 'MONEY', value: decimal(fyp), currency: 'MYR' },
        { metricCode: 'API', kind: 'MONEY', value: decimal(api), currency: 'MYR' },
        { metricCode: 'CASE_COUNT', kind: 'COUNT', value: caseCount },
      ],
      qualityGateResults: [],
    };
    const result = {
      tenant: TENANT, contestId: CONTEST_ID, contestVersionId: VERSION_ID, participantId: agent.agentId,
      eligibility: { status: 'ELIGIBLE', eligibleFrom: '2026-01-01', eligibleThrough: '2026-12-31', applicableCategoryCodes: ['ALL_ACTIVE_AGENTS'], reasonCodes: [] },
      currentResult: { businessDate: BUSINESS_DATE_WIRE, calculationState: 'CALCULATED', qualificationStatus: 'QUALIFIED', categoryResults: [categoryResult] },
      firstCalculatedAt: CREATED_AT, lastCalculatedAt: CREATED_AT, latestRunId: RUN_ID, configurationChecksum: checksum, engineVersion: 'synthetic-1.0.0',
    };
    const daily = { ...result, dailyResultId: `daily_${String(agent.agentId)}_20260727`, businessDate: BUSINESS_DATE_WIRE, calculationRevision: 1, sourceLineage, publicationStatus: 'PUBLISHED', runId: RUN_ID };
    await contestDb.collection(COLL.agentResults).updateOne({ tenant: TENANT, contestId: CONTEST_ID, contestVersionId: VERSION_ID, participantId: agent.agentId }, { $set: result }, { upsert: true });
    await contestDb.collection(COLL.agentDailyResults).updateOne({ tenant: TENANT, contestId: CONTEST_ID, contestVersionId: VERSION_ID, participantId: agent.agentId, businessDate: BUSINESS_DATE_WIRE, calculationRevision: 1 }, { $set: daily }, { upsert: true });
  }
  console.log(`Seeded ${CONTEST_ID} from ${agents.length} existing Mongo agents (${production.length} with production through ${BUSINESS_DATE_WIRE}).`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exitCode = 1; });