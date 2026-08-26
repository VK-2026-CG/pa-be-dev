import { closeDb, COLL, getContestDb } from '../src/db/mongo.js';
import { CONTEST_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

const APPLY = process.argv.includes('--apply');
const CUTOFF = new Date(process.env.STALE_JOB_CUTOFF ?? '2026-08-25T00:00:00.000Z');
const TIMESTAMP_FIELDS = new Set(['createdAt','updatedAt','completedAt','submittedAt','decidedAt','validatedAt','publishedAt','occurredAt','receivedAt','uploadedAt','archivedAt','startedAt','finishedAt','expiresAt']);
const statusFor = (operationId: string) => operationId === 'startContestBrochureImport' || operationId === 'startContestSimulation' || operationId === 'startContestCalculation' ? 202 : operationId.startsWith('create') || operationId === 'uploadContestBrochure' || operationId === 'reactivateContest' ? 201 : 200;

function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === 'object' && !(value instanceof Date) && !('_bsontype' in value)) return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, normalize(item, child)]));
  if (typeof value === 'string' && TIMESTAMP_FIELDS.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  return value;
}
function hasTimestampString(value: unknown, key = ''): boolean {
  if (Array.isArray(value)) return value.some(item => hasTimestampString(item));
  if (value && typeof value === 'object' && !(value instanceof Date) && !('_bsontype' in value)) return Object.entries(value).some(([child, item]) => hasTimestampString(item, child));
  return typeof value === 'string' && TIMESTAMP_FIELDS.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

async function main() {
  const country = getCountryContext().countryCode; const db = await getContestDb(); const summary: Record<string, number> = {};
  for (const name of CONTEST_COLLECTIONS) {
    let changed = 0; for (const doc of await db.collection(name).find({ tenant: country }).toArray()) {
      const next = normalize(doc) as typeof doc; if (hasTimestampString(doc)) { changed++; if (APPLY) await db.collection(name).replaceOne({ _id: doc._id }, next); }
    } summary[`${name}.timestampDocuments`] = changed;
  }
  const now = new Date('2026-08-25T00:00:00.000Z');
  const importIds = (await db.collection(COLL.contestImportJobs).find({ tenant: country, status: { $in: ['UPLOADING','QUEUED','INSPECTING','EXTRACTING','VALIDATING','MATERIALIZING'] } }).toArray()).filter(row => new Date(row.createdAt).getTime() < CUTOFF.getTime()).map(row => row._id);
  const simulationIds = (await db.collection(COLL.simulationRuns).find({ tenant: country, status: { $in: ['QUEUED','RUNNING'] } }).toArray()).filter(row => new Date(row.createdAt).getTime() < CUTOFF.getTime()).map(row => row._id);
  if (APPLY) {
    await db.collection(COLL.contestImportJobs).updateMany({ _id: { $in: importIds } }, { $set: { status: 'CANCELLED', stageCode: 'CANCELLED', completedAt: now, updatedAt: now, problem: { code: 'CON-4092', title: 'Cancelled during isolated-instance migration', retryable: false } } });
    await db.collection(COLL.simulationRuns).updateMany({ _id: { $in: simulationIds } }, { $set: { status: 'CANCELLED', completedAt: now, progressPct: 0, problem: { code: 'CON-4092', title: 'Cancelled during isolated-instance migration', retryable: false } } });
    for (const row of await db.collection(COLL.idempotencyRecords).find({ tenant: country, state: 'COMPLETED' }).toArray()) await db.collection(COLL.idempotencyRecords).updateOne({ _id: row._id }, { $set: { responseStatus: statusFor(String(row.operationId)), responseBody: normalize(row.responseBody), completedAt: normalize(row.completedAt, 'completedAt') } });
  }
  console.log(JSON.stringify({ mode: APPLY ? 'applied' : 'dry-run', country, database: db.databaseName, cutoff: CUTOFF, staleImports: importIds.length, staleSimulations: simulationIds.length, timestampDocuments: summary }, null, 2));
  await closeDb();
}
main().catch(async error => { console.error(error); await closeDb(); process.exitCode = 1; });