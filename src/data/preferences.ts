import type { Collection } from 'mongodb';
import { PERFORMANCE_READ_TIMEOUT_MS } from '../config/performance.js';
import { effectiveCatalog } from './catalog.js';
import type { Basis, MetricPreferences, Scope } from '../types.js';

/** Saved Customize Metrics choice for one agent and scope (C1 §5 `metric_preferences`). */
export interface SavedPreferences { priorityMetricCodes: string[]; focusMetricCodes: string[]; updatedAt: string }

export interface PreferenceStore {
  get(tenant: string, agentId: string, scope: Scope): Promise<SavedPreferences | undefined>;
  put(tenant: string, agentId: string, scope: Scope, prefs: SavedPreferences): Promise<void>;
}

/** Mongo collection holding agent preferences, in `MONGODB_PREFERENCES_DB`. */
export const PREFERENCES_COLLECTION = 'metrics_preferences';

/** Safe to expose: never carries driver messages, hosts or credentials. */
export class PreferencesStoreUnavailable extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'INS-5030';
  readonly title = 'Preferences store unavailable';
  constructor() { super('Preferences store unavailable'); }
}

/** One document per agent and scope; `_id` is the natural key, so no extra index is needed. */
interface PreferenceDoc {
  _id: { tenant: string; agentId: string; scope: Scope };
  priorityMetricCodes: string[];
  focusMetricCodes: string[];
  updatedAt: Date;
}

export class MongoPreferenceStore implements PreferenceStore {
  constructor(private readonly collection: Collection<PreferenceDoc>, private readonly timeoutMs = PERFORMANCE_READ_TIMEOUT_MS) {}

  async get(tenant: string, agentId: string, scope: Scope): Promise<SavedPreferences | undefined> {
    let doc: PreferenceDoc | null;
    try {
      doc = await this.collection.findOne({ _id: { tenant, agentId, scope } }, { maxTimeMS: this.timeoutMs });
    } catch {
      throw new PreferencesStoreUnavailable();
    }
    if (!doc || !Array.isArray(doc.priorityMetricCodes) || !Array.isArray(doc.focusMetricCodes)) return undefined;
    return {
      priorityMetricCodes: doc.priorityMetricCodes,
      focusMetricCodes: doc.focusMetricCodes,
      updatedAt: (doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt)).toISOString(),
    };
  }

  async put(tenant: string, agentId: string, scope: Scope, prefs: SavedPreferences): Promise<void> {
    try {
      await this.collection.replaceOne(
        { _id: { tenant, agentId, scope } },
        { priorityMetricCodes: prefs.priorityMetricCodes, focusMetricCodes: prefs.focusMetricCodes, updatedAt: new Date(prefs.updatedAt) },
        { upsert: true },
      );
    } catch {
      throw new PreferencesStoreUnavailable();
    }
  }
}

/** Process-local store for the offline memory engine and tests. */
export class MemoryPreferenceStore implements PreferenceStore {
  private readonly docs = new Map<string, SavedPreferences>();
  private key(tenant: string, agentId: string, scope: Scope) { return `${tenant}:${agentId}:${scope}`; }
  async get(tenant: string, agentId: string, scope: Scope) { return this.docs.get(this.key(tenant, agentId, scope)); }
  async put(tenant: string, agentId: string, scope: Scope, prefs: SavedPreferences) { this.docs.set(this.key(tenant, agentId, scope), prefs); }
  clear() { this.docs.clear(); }
}

/** Shared memory store used by the offline engine; `_resetPreferences` clears it between tests. */
export const memoryPreferences = new MemoryPreferenceStore();

export async function getPreferences(
  store: PreferenceStore, tenant: string, agentId: string, scope: Scope, basis: Basis,
): Promise<MetricPreferences> {
  const saved = await store.get(tenant, agentId, scope);
  if (saved) {
    return { priorityMetricCodes: saved.priorityMetricCodes, focusMetricCodes: saved.focusMetricCodes, source: 'AGENT', updatedAt: saved.updatedAt };
  }
  const cat = effectiveCatalog(scope, basis);
  return {
    priorityMetricCodes: cat.filter((d) => d.effCategory === 'PRIORITY').map((d) => d.metricCode),
    focusMetricCodes: cat.filter((d) => d.effCategory === 'FOCUS' && d.effSelected).map((d) => d.metricCode),
    source: 'DEFAULT', updatedAt: null,
  };
}

export interface PrefError { code: string; detail: string }
export async function putPreferences(
  store: PreferenceStore, tenant: string, agentId: string, scope: Scope, basis: Basis,
  body: { priorityMetricCodes: string[]; focusMetricCodes: string[] },
): Promise<{ ok: true; prefs: MetricPreferences } | { ok: false; error: PrefError }> {
  const cat = effectiveCatalog(scope, basis);
  const byCode = new Map(cat.map((d) => [d.metricCode, d]));
  const all = [...body.priorityMetricCodes, ...body.focusMetricCodes];
  const dupes = all.filter((c, i) => all.indexOf(c) !== i);
  if (dupes.length) return { ok: false, error: { code: 'INS-4223', detail: `Duplicate codes: ${dupes.join(', ')}` } };
  for (const c of all) {
    if (!byCode.has(c)) return { ok: false, error: { code: 'INS-4224', detail: `Metric ${c} not in the ${scope} catalog` } };
  }
  // MY: the scope's whole priority set is locked (editable=false), including
  // any metric a scope override promotes to PRIORITY while keeping its base
  // `customizable: true` flag.
  const lockedPriority = cat.filter((d) => d.effCategory === 'PRIORITY').map((d) => d.metricCode);
  const min = lockedPriority.length; const max = lockedPriority.length;
  if (body.priorityMetricCodes.length < min || body.priorityMetricCodes.length > max) {
    return { ok: false, error: { code: 'INS-4221', detail: `Priority metrics must contain exactly ${min} entries for MY` } };
  }
  const set = new Set(body.priorityMetricCodes);
  for (const c of lockedPriority) {
    if (!set.has(c)) return { ok: false, error: { code: 'INS-4222', detail: `Locked priority metric ${c} cannot be removed` } };
  }
  const updatedAt = new Date().toISOString();
  await store.put(tenant, agentId, scope, { priorityMetricCodes: body.priorityMetricCodes, focusMetricCodes: body.focusMetricCodes, updatedAt });
  return { ok: true, prefs: { priorityMetricCodes: body.priorityMetricCodes, focusMetricCodes: body.focusMetricCodes, source: 'AGENT', updatedAt } };
}
export function _resetPreferences(): void { memoryPreferences.clear(); }
