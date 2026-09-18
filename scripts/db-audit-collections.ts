import { closeDb, getContestDb, getPerformanceDb } from '../src/db/mongo.js';
import { CONTEST_COLLECTIONS, PERFORMANCE_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

async function main() {
  const country = getCountryContext().countryCode;
  const performance = await getPerformanceDb(); const contests = await getContestDb();
  const report = async (db: typeof performance, names: readonly string[]) => Object.fromEntries(await Promise.all(names.map(async name => [name, await db.collection(name).countDocuments({})])));
  console.log(JSON.stringify({ country, instances: { performance: performance.databaseName, contests: contests.databaseName, separated: performance.databaseName !== contests.databaseName }, performance: await report(performance, PERFORMANCE_COLLECTIONS), contestTarget: await report(contests, CONTEST_COLLECTIONS) }, null, 2));
}
main().catch(() => { console.error('Collection audit failed; no credentials or documents logged'); process.exitCode = 1; }).finally(closeDb);