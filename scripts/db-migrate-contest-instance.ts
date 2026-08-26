import { closeDb, getContestDb, getDb } from '../src/db/mongo.js';
import { CONTEST_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

const APPLY = process.argv.includes('--apply');
async function main() {
  const country = getCountryContext().countryCode; const source = await getDb(); const target = await getContestDb();
  if (source.databaseName === target.databaseName) throw new Error('Contest target must differ from the Insights source database');
  const summary: Record<string, { source: number; target: number; copied: number }> = {};
  for (const name of CONTEST_COLLECTIONS) {
    const docs = await source.collection(name).find({}).toArray();
    const mismatched = docs.filter(doc => doc.tenant !== country); if (mismatched.length) throw new Error(`${name} contains ${mismatched.length} documents outside COUNTRY_CODE=${country}`);
    let copied = 0;
    if (APPLY && docs.length) { const result = await target.collection(name).bulkWrite(docs.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })), { ordered: false }); copied = result.upsertedCount + result.modifiedCount; }
    summary[name] = { source: docs.length, target: await target.collection(name).countDocuments({}), copied };
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', country, source: source.databaseName, target: target.databaseName, collections: summary }, null, 2));
  await closeDb();
}
main().catch(async error => { console.error(error); await closeDb(); process.exitCode = 1; });