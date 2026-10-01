/**
 * Diagnoses INS-5030 ("source unavailable") on a machine: checks, in order, what the API needs from Mongo.
 * Read-only except one short-lived marker document in the preferences collection (removed again).
 * Credentials, hosts and driver messages are never printed. Usage: npm run db:diagnose [agentId]
 */
import { closeDb, getPerformanceDb, getPreferencesDb, PREFERENCES_DB_NAME } from '../src/db/mongo.js';
import { PERFORMANCE_DATABASES, PERFORMANCE_HIERARCHY_COLLECTION, PERFORMANCE_READ_TIMEOUT_MS } from '../src/config/performance.js';
import { PREFERENCES_COLLECTION } from '../src/data/preferences.js';

const agentId = process.argv[2] ?? '1136911';
const classify = (e: unknown): string => {
  const x = e as { name?: string; code?: unknown; message?: string };
  const m = String(x?.message ?? '');
  if (x?.name === 'MongoServerSelectionError' || /ENOTFOUND|ECONNREFUSED|ECONNRESET|server selection|getaddrinfo/i.test(m)) return 'cannot reach Atlas — check this machine\'s IP on the Atlas access list, VPN/firewall, and MONGODB_URI';
  if (x?.code === 13 || x?.code === 18 || /auth|not authorized|Unauthorized/i.test(m)) return 'authentication/authorization — wrong user/password in MONGODB_URI, or the user lacks rights on this database';
  if (x?.code === 50 || /timed? ?out|MaxTimeMSExpired|time limit/i.test(m)) return `timeout — slow network or unindexed scan exceeded the ${PERFORMANCE_READ_TIMEOUT_MS / 1000}s limit`;
  return `${x?.name ?? 'error'} (code ${String(x?.code ?? '-')})`;
};
let failed = 0;
async function step(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try { console.log(`PASS  ${name} — ${await fn()} (${Date.now() - t}ms)`); }
  catch (e) { failed++; console.log(`FAIL  ${name} — ${classify(e)} (${Date.now() - t}ms)`); }
}

console.log(`env: MONGODB_URI ${process.env.MONGODB_URI ? 'set' : 'MISSING'}, MONGODB_PERFORMANCE_URI ${process.env.MONGODB_PERFORMANCE_URI !== undefined ? 'set' : 'unset'}, preferences db = ${PREFERENCES_DB_NAME}`);
for (const key of ['PAMB', 'PBTB'] as const) {
  await step(`${key} ping (${PERFORMANCE_DATABASES[key]})`, async () => { await (await getPerformanceDb(key)).command({ ping: 1 }); return 'reachable'; });
  await step(`${key} read ${PERFORMANCE_HIERARCHY_COLLECTION} for agent ${agentId}`, async () => {
    const rows = await (await getPerformanceDb(key)).collection(PERFORMANCE_HIERARCHY_COLLECTION)
      .find({ 'hierarchy.leaderId': agentId }, { projection: { _id: 1 }, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS }).limit(1).toArray();
    return rows.length ? 'agent found' : 'read ok, agent not in this database (normal for one of the two)';
  });
}
await step(`preferences read (${PREFERENCES_DB_NAME}.${PREFERENCES_COLLECTION})`, async () => {
  await (await getPreferencesDb()).collection(PREFERENCES_COLLECTION).findOne({ _id: { tenant: 'MY', agentId: '__diagnose__', scope: 'SELF' } } as never, { maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS });
  return 'ok';
});
await step(`preferences write (${PREFERENCES_DB_NAME}.${PREFERENCES_COLLECTION})`, async () => {
  const col = (await getPreferencesDb()).collection(PREFERENCES_COLLECTION);
  const _id = { tenant: 'MY', agentId: '__diagnose__', scope: 'SELF' } as never;
  await col.replaceOne({ _id }, { priorityMetricCodes: [], focusMetricCodes: [], updatedAt: new Date() }, { upsert: true });
  await col.deleteOne({ _id });
  return 'write + delete ok';
});
console.log(failed ? `\n${failed} check(s) FAILED — the first FAIL above is the cause of INS-5030.` : '\nAll checks passed — the 503 is intermittent; run again under load or send the server log line "performance read FAILED".');
await closeDb();
process.exit(failed ? 1 : 0);
