import type { Db, Document } from 'mongodb';
import { PERFORMANCE_DATABASES, type PerformanceDatabaseKey } from '../../src/config/performance.js';

export interface FakeRequest { collection: string; query: Document; options: Document }

export interface FakeDbOptions {
  /** Consumed one per `toArray()` on `collection` (any collection when omitted): the read rejects with the error. */
  failures?: Array<{ error: Error; collection?: string }>;
}

const get = (row: Document, key: string): unknown => key.split('.').reduce<unknown>((v, part) => (v as Document | undefined)?.[part], row);

function matches(row: Document, query: Document): boolean {
  return Object.entries(query).every(([key, expected]) => {
    const field = get(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const op = expected as Record<string, unknown>;
      if ('$in' in op) return (op.$in as unknown[]).map(String).includes(String(field));
      if ('$gte' in op || '$lte' in op) {
        const n = typeof field === 'number' ? field : Number.NaN;
        return (op.$gte === undefined || n >= (op.$gte as number)) && (op.$lte === undefined || n <= (op.$lte as number));
      }
    }
    if (Array.isArray(field)) return field.map(String).includes(String(expected));
    return String(field) === String(expected);
  });
}

/** Include-mode projection by top-level field (what the whitelist needs): `_id` stays unless `_id: 0`. */
function project(row: Document, projection: Document | undefined): Document {
  if (!projection) return row;
  const keep = new Set(Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k.split('.')[0]!));
  if (projection._id !== 0) keep.add('_id');
  return Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)));
}

/** A Mongo `Db` double that applies filters, projection and sort like the driver, and records every `find`. */
export function fakeMongoDb(key: PerformanceDatabaseKey, data: Record<string, Document[]> = {}, options: FakeDbOptions = {}) {
  const requests: FakeRequest[] = [];
  const failures = [...(options.failures ?? [])];
  const db = {
    databaseName: PERFORMANCE_DATABASES[key],
    collection: (collection: string) => ({
      find: (query: Document, findOptions: Document = {}) => {
        requests.push({ collection, query, options: findOptions });
        let rows = (data[collection] ?? []).filter((row) => matches(row, query));
        const cursor = {
          sort: (order: Document) => {
            rows = [...rows].sort((a, b) => {
              for (const [field, direction] of Object.entries(order)) {
                const av = get(a, field) as number | string | undefined, bv = get(b, field) as number | string | undefined;
                if (av === bv) continue;
                if (av === undefined) return Number(direction);
                if (bv === undefined) return -Number(direction);
                return (av < bv ? -1 : 1) * Number(direction);
              }
              return 0;
            });
            return cursor;
          },
          limit: (n: number) => { rows = rows.slice(0, n); return cursor; },
          toArray: async () => {
            const index = failures.findIndex((f) => f.collection === undefined || f.collection === collection);
            if (index >= 0) throw failures.splice(index, 1)[0]!.error;
            return rows.map((row) => structuredClone(project(row, findOptions.projection as Document | undefined)));
          },
        };
        return cursor;
      },
    }),
  } as unknown as Db;
  return { db, requests };
}

export function fakeMongo(
  pamb: Record<string, Document[]> = {}, pbtb: Record<string, Document[]> = {},
  options: { PAMB?: FakeDbOptions; PBTB?: FakeDbOptions } = {},
) {
  const a = fakeMongoDb('PAMB', pamb, options.PAMB);
  const b = fakeMongoDb('PBTB', pbtb, options.PBTB);
  return { dbs: { PAMB: a.db, PBTB: b.db }, pamb: a, pbtb: b };
}
