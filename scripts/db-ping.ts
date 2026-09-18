/** Read-only connectivity check using the same Performance connection as the API. */
import { getPerformanceDb, closeDb } from '../src/db/mongo.js';

console.log('Checking Performance MongoDB connectivity (credentials not logged)…');

getPerformanceDb()
  .then(async (db) => {
    await db.command({ ping: 1 });
    console.log('Atlas reachable — ping ok.');
  })
  .catch((e: Error) => {
    console.error('Cannot reach Atlas:', e.name);
    console.error('Check Performance URI (dedicated or shared), database configuration, credentials and network access.');
    process.exitCode = 1;
  }).finally(closeDb);
