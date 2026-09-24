import { effectiveCatalog } from './catalog.js';
import type { Basis, MetricPreferences, Scope } from '../types.js';

const store = new Map<string, { priority: string[]; focus: string[]; updatedAt: string }>();
const key = (tenant: string, agentId: string, scope: Scope) => `${tenant}:${agentId}:${scope}`;

export function getPreferences(tenant: string, agentId: string, scope: Scope, basis: Basis): MetricPreferences {
  const saved = store.get(key(tenant, agentId, scope));
  if (saved) {
    return { priorityMetricCodes: saved.priority, focusMetricCodes: saved.focus, source: 'AGENT', updatedAt: saved.updatedAt };
  }
  const cat = effectiveCatalog(scope, basis);
  return {
    priorityMetricCodes: cat.filter((d) => d.effCategory === 'PRIORITY').map((d) => d.metricCode),
    focusMetricCodes: cat.filter((d) => d.effCategory === 'FOCUS' && d.effSelected).map((d) => d.metricCode),
    source: 'DEFAULT', updatedAt: null,
  };
}

export interface PrefError { code: string; detail: string }
export function putPreferences(
  tenant: string, agentId: string, scope: Scope, basis: Basis,
  body: { priorityMetricCodes: string[]; focusMetricCodes: string[] },
): { ok: true; prefs: MetricPreferences } | { ok: false; error: PrefError } {
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
  store.set(key(tenant, agentId, scope), { priority: body.priorityMetricCodes, focus: body.focusMetricCodes, updatedAt });
  return { ok: true, prefs: { priorityMetricCodes: body.priorityMetricCodes, focusMetricCodes: body.focusMetricCodes, source: 'AGENT', updatedAt } };
}
export function _resetPreferences(): void { store.clear(); }
