import { closeDb, getContestDb, getDb } from '../src/db/mongo.js';
import { CONTEST_COLLECTIONS, DEVELOPMENT_SOURCE_COLLECTIONS, INSIGHTS_COLLECTIONS, LEGACY_CONTEST_COLLECTIONS } from '../src/db/collection-ownership.js';
import { getCountryContext } from '../src/config/country.js';

async function main() {
  const country = getCountryContext().countryCode; const insights = await getDb(); const contests = await getContestDb();
  const report = async (db: typeof insights, names: readonly string[]) => Object.fromEntries(await Promise.all(names.map(async name => [name, await db.collection(name).countDocuments({})])));
  console.log(JSON.stringify({ country, instances: { insights: insights.databaseName, contests: contests.databaseName, separated: insights.databaseName !== contests.databaseName }, insights: await report(insights, INSIGHTS_COLLECTIONS), developmentSources: await report(insights, DEVELOPMENT_SOURCE_COLLECTIONS), contestTarget: await report(contests, CONTEST_COLLECTIONS), legacyInInsights: await report(insights, LEGACY_CONTEST_COLLECTIONS) }, null, 2));
  await closeDb();
}
main().catch(async error => { console.error(error); await closeDb(); process.exitCode = 1; });