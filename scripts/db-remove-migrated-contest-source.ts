import { closeDb, getContestDb, getDb } from '../src/db/mongo.js';
import { CONTEST_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

const CONFIRM = process.argv.includes('--confirm');
async function main() {
  const country = getCountryContext().countryCode; const source = await getDb(); const target = await getContestDb();
  if (source.databaseName === target.databaseName) throw new Error('Refusing cleanup because source and target are the same database');
  const collections = [];
  for (const name of CONTEST_COLLECTIONS) {
    const sourceDocs = await source.collection(name).find({}).toArray(); const targetCount = await target.collection(name).countDocuments({});
    if (sourceDocs.some(doc => doc.tenant !== country)) throw new Error(`${name} contains documents outside COUNTRY_CODE=${country}`);
    if (targetCount !== sourceDocs.length) throw new Error(`${name} target count ${targetCount} does not match source ${sourceDocs.length}`);
    collections.push({ name, source: sourceDocs.length, target: targetCount });
  }
  if (CONFIRM) for (const { name } of collections) if ((await source.listCollections({ name }, { nameOnly: true }).toArray()).length) await source.collection(name).drop();
  console.log(JSON.stringify({ mode: CONFIRM ? 'deleted-source' : 'dry-run', country, source: source.databaseName, target: target.databaseName, collections }, null, 2));
  await closeDb();
}
main().catch(async error => { console.error(error); await closeDb(); process.exitCode = 1; });