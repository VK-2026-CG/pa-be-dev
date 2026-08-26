import { closeDb, getDb } from '../src/db/mongo.js';
import { LEGACY_CONTEST_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

const CONFIRM = process.argv.includes('--confirm');
async function main() {
  const country = getCountryContext().countryCode; const db = await getDb(); const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name));
  const collections = [];
  for (const name of LEGACY_CONTEST_COLLECTIONS) if (existing.has(name)) { const count = await db.collection(name).countDocuments({}); collections.push({ name, count }); if (CONFIRM) await db.collection(name).drop(); }
  console.log(JSON.stringify({ mode: CONFIRM ? 'deleted' : 'dry-run', country, database: db.databaseName, collections }, null, 2));
  await closeDb();
}
main().catch(async error => { console.error(error); await closeDb(); process.exitCode = 1; });