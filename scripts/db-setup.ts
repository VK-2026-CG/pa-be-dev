/**
 * db-setup — creates the C1 collections in MongoDB Atlas with $jsonSchema
 * validators and the unique indexes defined in
 * pruaction-spec/domains/insights/data/mongodb.md.
 *
 *   npm run db:setup        (reads MONGODB_URI / MONGODB_DB from .env)
 *
 * Validators require the key + lineage fields and stay permissive on the
 * value body (additionalProperties true) so pipeline evolution is additive.
 * Safe to re-run: collMod on existing collections, createIndex is idempotent.
 */
import { COLL, DB_NAME, closeDb, getDb } from '../src/db/mongo.js';

const lineage = {
  asOfDate: { bsonType: 'date' },
  asOfDateStr: { bsonType: 'string', description: 'ISO yyyy-mm-dd mirror for API echo' },
  computedAt: { bsonType: 'date' },
  sourceBatchId: { bsonType: 'string' },
};

const VALIDATORS: Record<string, object> = {
  [COLL.snapshots]: {
    bsonType: 'object',
    required: ['tenant', 'agentId', 'metricCode', 'period', 'businessLine', 'basis', 'scope', 'teamView', 'valueType', 'payload', 'asOfDate', 'computedAt', 'sourceBatchId'],
    properties: {
      tenant: { bsonType: 'string' },
      agentId: { bsonType: 'string' },
      metricCode: { bsonType: 'string' },
      period: {
        bsonType: 'object', required: ['type', 'year'],
        properties: {
          type: { enum: ['MTD', 'QTD', 'YTD'] }, year: { bsonType: 'int' },
          quarter: { bsonType: ['int', 'null'] }, month: { bsonType: ['int', 'null'] },
          startDate: { bsonType: 'date' }, endDate: { bsonType: 'date' },
        },
        additionalProperties: true,
      },
      businessLine: { enum: ['ALL', 'INSURANCE', 'TAKAFUL'] },
      basis: { enum: ['STANDARD', 'SCHEME'] },
      scope: { enum: ['SELF', 'TEAM'] },
      teamView: { enum: ['-', 'DIRECT', 'GROUP'] },
      valueType: { enum: ['MONEY', 'COUNT', 'PERCENT', 'DECIMAL'] },
      /*
       * v1.4.0 (mongodb.md §7.12/§7.13): `values.collected` is NOT required. An
       * absent or null source measure yields no collected value — it is never
       * zero-filled — and the metric resolves through the `dataState` rules, so a
       * document with `dataState` != OK must validate. (This repo stores the
       * API-shaped body under `payload`; `values` is declared here for pipeline-
       * written docs that follow the C1 table directly.)
       */
      values: { bsonType: 'object', additionalProperties: true },
      dataState: { enum: ['OK', 'PROCESSING', 'EMPTY'], description: 'Absent ⇒ OK (contract default)' },
      notices: {
        bsonType: 'array',
        items: {
          bsonType: 'object', required: ['code', 'severity'],
          properties: {
            code: { bsonType: 'string' },
            severity: { enum: ['INFO', 'WARNING'] },
            params: { bsonType: 'object' },
          },
          additionalProperties: true,
        },
      },
      order: { bsonType: 'int' },
      context: { bsonType: 'object' },
      payload: { bsonType: 'object', description: 'API-shaped MetricSnapshot (list item)' },
      detailPayload: { bsonType: 'object', description: 'API-shaped MetricDetail' },
      ...lineage,
    },
    additionalProperties: true,
  },
  [COLL.series]: {
    bsonType: 'object',
    required: ['tenant', 'agentId', 'metricCode', 'scope', 'teamView', 'businessLine', 'basis', 'year', 'valueType', 'points', 'asOfDate', 'computedAt', 'sourceBatchId'],
    properties: {
      tenant: { bsonType: 'string' }, agentId: { bsonType: 'string' }, metricCode: { bsonType: 'string' },
      scope: { enum: ['SELF', 'TEAM'] }, teamView: { enum: ['-', 'DIRECT', 'GROUP'] },
      businessLine: { enum: ['ALL', 'INSURANCE', 'TAKAFUL'] }, basis: { enum: ['STANDARD', 'SCHEME'] },
      year: { bsonType: 'int' },
      valueType: { enum: ['MONEY', 'COUNT', 'PERCENT', 'DECIMAL'] },
      points: {
        bsonType: 'array', minItems: 12, maxItems: 12,
        items: {
          bsonType: 'object', required: ['month'],
          properties: { month: { bsonType: 'int', minimum: 1, maximum: 12 } },
          additionalProperties: true,
        },
      },
      ...lineage,
    },
    additionalProperties: true,
  },
  [COLL.milestones]: {
    bsonType: 'object',
    required: ['tenant', 'agentId', 'programCode', 'variant', 'cycleYear', 'payload', 'asOfDate', 'computedAt', 'sourceBatchId'],
    properties: {
      tenant: { bsonType: 'string' }, agentId: { bsonType: 'string' },
      programCode: { bsonType: 'string' }, variant: { bsonType: 'string' },
      cycleYear: { bsonType: 'int' }, priority: { bsonType: 'bool' }, order: { bsonType: 'int' },
      payload: { bsonType: 'object', description: 'API-shaped MilestoneProgress' },
      ...lineage,
    },
    additionalProperties: true,
  },
  [COLL.metricDefs]: {
    bsonType: 'object',
    required: ['tenant', 'metricCode', 'definition', 'active', 'updatedAt'],
    properties: {
      tenant: { bsonType: 'string' }, metricCode: { bsonType: 'string' },
      definition: { bsonType: 'object', description: 'MetricDefinition (OpenAPI shape)' },
      active: { bsonType: 'bool' }, updatedAt: { bsonType: 'date' },
    },
    additionalProperties: true,
  },
  [COLL.milestoneDefs]: {
    bsonType: 'object',
    required: ['tenant', 'programCode', 'tiers'],
    properties: {
      tenant: { bsonType: 'string' }, programCode: { bsonType: 'string' },
      tiers: { bsonType: 'array' },
    },
    additionalProperties: true,
  },
  [COLL.preferences]: {
    bsonType: 'object',
    required: ['priorityMetricCodes', 'focusMetricCodes', 'updatedAt'],
    properties: {
      priorityMetricCodes: { bsonType: 'array', items: { bsonType: 'string' } },
      focusMetricCodes: { bsonType: 'array', items: { bsonType: 'string' } },
      updatedAt: { bsonType: 'string' },
    },
    additionalProperties: true,
  },
  [COLL.recommendations]: {
    bsonType: 'object',
    required: ['tenant', 'agentId', 'scope', 'context', 'recommendationId', 'payload', 'generatedAt', 'expiresAt'],
    properties: {
      tenant: { bsonType: 'string' }, agentId: { bsonType: 'string' },
      scope: { enum: ['SELF', 'TEAM'] }, context: { enum: ['PERFORMANCE'] },
      recommendationId: { bsonType: 'string' },
      payload: { bsonType: 'object', description: 'API-shaped RecommendationList + panel' },
      generatedAt: { bsonType: 'date' }, expiresAt: { bsonType: 'date' },
    },
    additionalProperties: true,
  },
  [COLL.recoFeedback]: {
    bsonType: 'object',
    required: ['rating', 'updatedAt'],
    properties: { rating: { enum: ['UP', 'DOWN'] }, updatedAt: { bsonType: 'string' } },
    additionalProperties: true,
  },
};

VALIDATORS[COLL.mockAgents] = { bsonType: 'object', required: ['tenant', 'agentId', 'agentCode', 'name', 'rank', 'region', 'channel', 'active'], additionalProperties: true };
VALIDATORS[COLL.mockProduction] = { bsonType: 'object', required: ['tenant', 'transactionId', 'agentId', 'policyNumber', 'transactionDate', 'businessLine', 'productType', 'fyp', 'api', 'caseCount'], additionalProperties: true };

async function main() {
  const db = await getDb();
  console.log(`Connected. Ensuring collections in db "${DB_NAME}"…`);
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  for (const [name, schema] of Object.entries(VALIDATORS)) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
      console.log(`  ~ ${name} (validator updated)`);
    } else {
      await db.createCollection(name, { validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
      console.log(`  + ${name}`);
    }
  }

  // Unique indexes — verbatim from mongodb.md.
  await db.collection(COLL.snapshots).createIndex(
    { tenant: 1, agentId: 1, scope: 1, teamView: 1, metricCode: 1, 'period.type': 1, 'period.year': 1, 'period.quarter': 1, 'period.month': 1, businessLine: 1, basis: 1 },
    { unique: true, name: 'uq_snapshot_key' },
  );
  await db.collection(COLL.series).createIndex(
    { tenant: 1, agentId: 1, scope: 1, teamView: 1, metricCode: 1, businessLine: 1, basis: 1, year: -1 },
    { unique: true, name: 'uq_series_key' },
  );
  await db.collection(COLL.milestones).createIndex(
    { tenant: 1, agentId: 1, programCode: 1, variant: 1, cycleYear: -1 },
    { unique: true, name: 'uq_milestone_key' },
  );
  await db.collection(COLL.metricDefs).createIndex({ tenant: 1, metricCode: 1 }, { unique: true, name: 'uq_metricdef_key' });
  await db.collection(COLL.milestoneDefs).createIndex({ tenant: 1, programCode: 1 }, { unique: true, name: 'uq_milestonedef_key' });
  await db.collection(COLL.recommendations).createIndex({ tenant: 1, agentId: 1, scope: 1, context: 1 }, { unique: true, name: 'uq_reco_key' });
  await db.collection(COLL.recommendations).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_reco' });
  await db.collection(COLL.mockAgents).createIndex({ tenant: 1, agentId: 1 }, { unique: true, name: 'uq_mock_agent' });
  await db.collection(COLL.mockProduction).createIndex({ tenant: 1, transactionId: 1 }, { unique: true, name: 'uq_mock_transaction' });
  await db.collection(COLL.mockProduction).createIndex({ tenant: 1, agentId: 1, transactionDate: -1 }, { name: 'ix_mock_production_agent_date' });
  console.log('Indexes ensured.');
  await closeDb();
  console.log('db:setup done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
