import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clients: [] as Array<{ uri: string; databases: string[]; closed: boolean }>, fail: false }));
vi.mock('mongodb', async importOriginal => {
  const original = await importOriginal<typeof import('mongodb')>();
  return { ...original, MongoClient: class {
    record: { uri: string; databases: string[]; closed: boolean };
    constructor(uri: string) { this.record = { uri, databases: [], closed: false }; state.clients.push(this.record); }
    async connect() { if (state.fail) throw new Error('private connection details'); return this; }
    db(name: string) { this.record.databases.push(name); return { databaseName: name }; }
    async close() { this.record.closed = true; }
  } };
});

beforeEach(() => {
  vi.resetModules(); state.clients.length = 0; state.fail = false;
  vi.stubEnv('MONGODB_URI', 'mongodb://contest.invalid');
  vi.stubEnv('MONGODB_CONTEST_DB', 'contests');
  vi.stubEnv('MONGODB_PERFORMANCE_DB', 'pa_performance_PAMB-dev');
  vi.stubEnv('MONGODB_PERFORMANCE_URI', 'mongodb://performance.invalid');
});
afterEach(() => vi.unstubAllEnvs());

describe('independent Performance Mongo connection', () => {
  it('AC-PA-DIRECT-23 dedicated URI never redirects Contest and simultaneous reads share connection', async () => {
    const mongo = await import('../src/db/mongo.js');
    const [a, b, c] = await Promise.all([mongo.getPerformanceDb(), mongo.getPerformanceDb(), mongo.getContestDb()]);
    expect(a.databaseName).toBe('pa_performance_PAMB-dev');
    expect(b.databaseName).toBe(a.databaseName);
    expect(c.databaseName).toBe('contests');
    expect(state.clients).toHaveLength(2);
    expect(state.clients.find(client => client.uri === 'mongodb://performance.invalid')?.databases).toEqual(['pa_performance_PAMB-dev', 'pa_performance_PAMB-dev']);
    expect(state.clients.find(client => client.uri === 'mongodb://contest.invalid')?.databases).toEqual(['contests']);
    await mongo.closeDb();
    expect(state.clients.every(client => client.closed)).toBe(true);
  });
  it('AC-PA-DIRECT-23 explicit empty dedicated URI cannot fall back to shared credentials', async () => {
    vi.stubEnv('MONGODB_PERFORMANCE_URI', '');
    const mongo = await import('../src/db/mongo.js');
    await expect(mongo.getPerformanceDb()).rejects.toThrow('connection required');
    expect(state.clients).toHaveLength(0);
  });
  it('AC-PA-DIRECT-23 failed dedicated connection is sanitized, closed and retryable', async () => {
    const mongo = await import('../src/db/mongo.js');
    state.fail = true;
    await expect(mongo.getPerformanceDb()).rejects.toThrow('Performance database connection failed');
    expect(state.clients[0]?.closed).toBe(true);
    state.fail = false;
    expect((await mongo.getPerformanceDb()).databaseName).toBe('pa_performance_PAMB-dev');
    expect(state.clients).toHaveLength(2);
    await mongo.closeDb();
  });
});