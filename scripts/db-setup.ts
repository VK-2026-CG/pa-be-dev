import { closeDb, getPerformanceDb } from '../src/db/mongo.js';
import { performanceProfile } from '../src/data/performance-profile.js';
import { provisionPerformance } from '../src/data/performance-import.js';

async function main() {
  performanceProfile();
  const db = await getPerformanceDb();
  await provisionPerformance(db);
  console.log('Performance schemas and indexes validated: three collections only');
}
main().catch(() => { console.error('Performance setup failed; inspect target schema/config without logging documents'); process.exitCode = 1; }).finally(closeDb);