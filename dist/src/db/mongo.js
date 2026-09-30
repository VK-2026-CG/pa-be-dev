/**
 * Separate Performance/Contest databases, with an optional dedicated Performance client.
 *
 * Config via env (a `.env` in the repo root is auto-loaded — no dep):
 *   MONGODB_URI  mongodb+srv://user:pass@cluster.../  (enables Mongo mode)
 *   MONGODB_PAMB_DB pa_performance_PAMB-dev (INSURANCE/ALL Performance reads)
 *   MONGODB_PBTB_DB pa_performance_PBTB-dev (TAKAFUL Performance reads)
 *   MONGODB_PERFORMANCE_URI optional dedicated Performance connection (same cluster/credentials for both databases)
 *   MONGODB_DB legacy migration source only; not used by Performance requests
 *
 * Only the explicit offline/test source path uses the in-memory engine; a
 * configured Performance source never falls back after a connection failure.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { performanceConnection, PERFORMANCE_READ_TIMEOUT_MS } from '../config/performance.js';
function loadDotEnv() {
    for (const file of ['.env', '.env.local']) {
        try {
            const txt = readFileSync(resolve(process.cwd(), file), 'utf8');
            for (const line of txt.split('\n')) {
                const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n#]*)"?\s*$/.exec(line);
                if (m && process.env[m[1]] === undefined)
                    process.env[m[1]] = m[2].trim();
            }
        }
        catch { /* file absent — fine */ }
    }
}
loadDotEnv();
export const MONGO_ENABLED = Boolean(process.env.MONGODB_URI);
export const DB_NAME = process.env.MONGODB_DB ?? 'insights';
/** Country instances are isolated; Contest never inherits the Insights database name. */
export const CONTEST_DB_NAME = process.env.MONGODB_CONTEST_DB ?? 'contests';
let client = null;
let connection = null;
let performanceClient = null;
let performanceConnectionPromise = null;
async function connect() {
    if (!process.env.MONGODB_URI)
        throw new Error('MONGODB_URI not set');
    if (!connection) {
        client = new MongoClient(process.env.MONGODB_URI, {
            appName: 'pruaction-insights-service',
            serverSelectionTimeoutMS: 8000,
        });
        connection = client.connect().catch(async (error) => {
            await client?.close();
            client = null;
            connection = null;
            throw error;
        });
    }
    return connection;
}
/** Legacy maintenance commands only. Performance runtime never calls this. */
export async function getDb() {
    return (await connect()).db(DB_NAME);
}
export async function getContestDb() {
    return (await connect()).db(CONTEST_DB_NAME);
}
/** Separate named Performance source database; never changes Contest storage. */
export async function getPerformanceDb(key = 'PAMB') {
    const { databases, uri } = performanceConnection();
    const database = databases[key];
    if (process.env.MONGODB_PERFORMANCE_URI === undefined)
        return (await connect()).db(database);
    if (!performanceConnectionPromise) {
        const dedicated = new MongoClient(uri, {
            appName: 'pruaction-performance-source', serverSelectionTimeoutMS: PERFORMANCE_READ_TIMEOUT_MS,
        });
        performanceClient = dedicated;
        performanceConnectionPromise = dedicated.connect().catch(async () => {
            await dedicated.close();
            performanceClient = null;
            performanceConnectionPromise = null;
            throw new Error('Performance database connection failed');
        });
    }
    return (await performanceConnectionPromise).db(database);
}
export async function closeDb() {
    const clients = [client, performanceClient];
    client = null;
    connection = null;
    performanceClient = null;
    performanceConnectionPromise = null;
    await Promise.all(clients.filter((item) => item !== null).map(item => item.close()));
}
/** Performance source collections plus independently owned Contest collections. */
export const COLL = {
    production: 'my_production', mapa: 'my_mapa', persistency: 'my_persistency',
    contests: 'contests', contestVersions: 'contest_versions',
    audit: 'audit_events',
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
};
