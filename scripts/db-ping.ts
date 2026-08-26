/** Connectivity check: `npm run db:ping` — verifies MONGODB_URI reaches Atlas. */
import { MongoClient } from 'mongodb';
import { DB_NAME } from '../src/db/mongo.js'; // side effect: loads .env / .env.local

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI not set. Create a .env in the repo root (see .env.example).');
  process.exit(1);
}
const redacted = uri.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
console.log(`Connecting to ${redacted} (db: ${DB_NAME})…`);

const c = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
c.connect()
  .then(async () => {
    await c.db(DB_NAME).command({ ping: 1 });
    console.log('Atlas reachable — ping ok.');
    await c.close();
  })
  .catch((e: Error) => {
    console.error('Cannot reach Atlas:', e.name, '-', String(e.message).slice(0, 160));
    console.error('Check: Atlas Network Access allows your IP, credentials are valid, URI is correct.');
    process.exit(1);
  });
