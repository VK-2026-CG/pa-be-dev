import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { closeDb, getPerformanceDb } from '../src/db/mongo.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DB, performanceProfile } from '../src/data/performance-profile.js';
import { inspectImport, normalizeMockRecord, parseMockRecords, provisionPerformance, type MockImport } from '../src/data/performance-import.js';

async function main() {
  performanceProfile(); // fail closed before parsing files or opening a connection
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const value = (key: string) => {
    const i = args.indexOf(key);
    if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`Required argument: ${key}`);
    return args[i + 1]!;
  };
  const rows: MockImport = { my_production: [], my_mapa: [], my_persistency: [] };
  const hashes: Record<string, string> = {};
  for (const name of PERFORMANCE_COLLECTIONS) {
    const bytes = readFileSync(value(`--${name.slice(3)}`));
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    rows[name] = parseMockRecords(bytes.toString('utf8')).map(row => normalizeMockRecord(name, row));
  }
  const db = await getPerformanceDb();
  const preview = await inspectImport(db, rows);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', database: PERFORMANCE_DB, counts: preview.counts, sha256: hashes }));
  if (!apply) return;
  await provisionPerformance(db);
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const name of PERFORMANCE_COLLECTIONS) {
        if (preview.pending[name].length) await db.collection(name).insertMany(preview.pending[name], { session, ordered: true });
      }
    });
  } finally { await session.endSession(); }
  console.log(JSON.stringify({ status: 'imported', counts: Object.fromEntries(await Promise.all(PERFORMANCE_COLLECTIONS.map(async name => [name, await db.collection(name).countDocuments()])))}));
}

main().catch(error => {
  // Driver errors can echo offending documents. Never dump raw error objects.
  console.error(error?.name?.startsWith('Mongo') ? `Mongo import failed (${error.codeName ?? error.name}); no source document logged` : String(error.message));
  process.exitCode = 1;
}).finally(closeDb);