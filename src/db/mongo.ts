/**
 * MongoDB (Atlas) connection for the insights service.
 *
 * Config via env (a `.env` in the repo root is auto-loaded — no dep):
 *   MONGODB_URI  mongodb+srv://user:pass@cluster.../  (enables Mongo mode)
 *   MONGODB_DB   database name, default "insights"
 *
 * When MONGODB_URI is unset the service runs on the in-memory deterministic
 * engine (tests and local dev need no database).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, type Db } from 'mongodb';

function loadDotEnv(): void {
  for (const file of ['.env', '.env.local']) {
    try {
      const txt = readFileSync(resolve(process.cwd(), file), 'utf8');
      for (const line of txt.split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n#]*)"?\s*$/.exec(line);
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
      }
    } catch { /* file absent — fine */ }
  }
}
loadDotEnv();

export const MONGO_ENABLED = Boolean(process.env.MONGODB_URI);
export const DB_NAME = process.env.MONGODB_DB ?? 'insights';
/** Country instances are isolated; Contest never inherits the Insights database name. */
export const CONTEST_DB_NAME = process.env.MONGODB_CONTEST_DB ?? 'contests';

let client: MongoClient | null = null;

export async function getDb(): Promise<Db> {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI, {
      appName: 'pruaction-insights-service',
      serverSelectionTimeoutMS: 8000,
    });
    await client.connect();
  }
  return client.db(DB_NAME);
}

export async function getContestDb(): Promise<Db> {
  await getDb();
  return client!.db(CONTEST_DB_NAME);
}

export async function closeDb(): Promise<void> {
  if (client) { await client.close(); client = null; }
}

/** Collection names — contract C1 (pruaction-spec mongodb.md). */
export const COLL = {
  snapshots: 'metric_snapshots',
  series: 'metric_series',
  milestones: 'milestone_progress',
  metricDefs: 'metric_definitions',
  milestoneDefs: 'milestone_definitions',
  preferences: 'metric_preferences',
  recommendations: 'recommendations',
  recoFeedback: 'recommendation_feedback',
  contests: 'contests', contestVersions: 'contest_versions',
  audit: 'audit_events',
  mockAgents: 'mock_agent_master', mockProduction: 'mock_production_transactions',
  brochures: 'contest_brochures',
  contestImportJobs: 'contest_import_jobs',
  ruleDefinitions: 'rule_definitions', ruleVersions: 'rule_versions',
  approvalInstances: 'approval_instances', approvalDecisions: 'approval_decisions',
  validationRuns: 'validation_runs', simulationRuns: 'simulation_runs', simulationResults: 'simulation_results',
  sourceSnapshots: 'source_snapshots', agentStaging: 'agent_snapshot_staging', productionStaging: 'production_snapshot_staging',
  calculationRuns: 'contest_calculation_runs', agentResults: 'contest_agent_results', agentDailyResults: 'contest_agent_daily_results',
  qualificationExplanations: 'qualification_explanations', publicationJobs: 'publication_jobs',
  contestOutbox: 'contest_outbox', contestNotifications: 'contest_notifications',
  idempotencyRecords: 'command_idempotency',
} as const;
