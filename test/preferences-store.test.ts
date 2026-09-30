import { describe, expect, it } from 'vitest';
import type { Collection } from 'mongodb';
import { getPreferences, MongoPreferenceStore, PreferencesStoreUnavailable, putPreferences } from '../src/data/preferences.js';

/** Minimal in-memory stand-in for the `metrics_preferences` collection (findOne/replaceOne by `_id`). */
function fakeCollection(fail = false) {
  const docs = new Map<string, any>();
  const calls: Array<{ op: string; filter: any; options?: any }> = [];
  const col = {
    findOne: async (filter: any, options?: any) => {
      calls.push({ op: 'findOne', filter, options });
      if (fail) throw new Error('mongodb+srv://user:secret@host timed out');
      return docs.get(JSON.stringify(filter._id)) ?? null;
    },
    replaceOne: async (filter: any, doc: any, options?: any) => {
      calls.push({ op: 'replaceOne', filter, options });
      if (fail) throw new Error('mongodb+srv://user:secret@host timed out');
      docs.set(JSON.stringify(filter._id), { _id: filter._id, ...doc });
    },
  };
  return { col: col as unknown as Collection<any>, docs, calls };
}

describe('Mongo metrics_preferences store', () => {
  const body = { priorityMetricCodes: ['TPC', 'PTPC', 'CASE_COUNT', 'FYP'], focusMetricCodes: ['FYC', 'PERSISTENCY_Y1'] };

  it('persists one document per tenant/agent/scope and reads it back as AGENT preferences', async () => {
    const { col, docs, calls } = fakeCollection();
    const store = new MongoPreferenceStore(col);
    expect((await getPreferences(store, 'MY', 'A1', 'SELF', 'STANDARD')).source).toBe('DEFAULT');
    const res = await putPreferences(store, 'MY', 'A1', 'SELF', 'STANDARD', body);
    expect(res.ok).toBe(true);
    const saved = [...docs.values()][0];
    expect(saved._id).toEqual({ tenant: 'MY', agentId: 'A1', scope: 'SELF' });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(calls.find(c => c.op === 'replaceOne')?.options).toEqual({ upsert: true });
    const read = await getPreferences(store, 'MY', 'A1', 'SELF', 'STANDARD');
    expect(read).toMatchObject({ ...body, source: 'AGENT' });
    // SELF and TEAM are independent documents.
    expect((await getPreferences(store, 'MY', 'A1', 'TEAM', 'STANDARD')).source).toBe('DEFAULT');
  });

  it('does not write invalid preferences', async () => {
    const { col, docs } = fakeCollection();
    const res = await putPreferences(new MongoPreferenceStore(col), 'MY', 'A1', 'SELF', 'STANDARD', { ...body, focusMetricCodes: ['NOPE'] });
    expect(res).toMatchObject({ ok: false, error: { code: 'INS-4224' } });
    expect(docs.size).toBe(0);
  });

  it('maps driver failures to a sanitized 503 without leaking connection details', async () => {
    const store = new MongoPreferenceStore(fakeCollection(true).col);
    const error = await getPreferences(store, 'MY', 'A1', 'SELF', 'STANDARD').catch(e => e);
    expect(error).toBeInstanceOf(PreferencesStoreUnavailable);
    expect(error).toMatchObject({ status: 503, code: 'INS-5030' });
    expect(String(error.message)).not.toContain('secret');
  });
});
