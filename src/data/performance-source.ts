import type { Db, Document } from 'mongodb';
import type { DataSource, TeamListRequest } from './source.js';
import type { AgentRecord } from './registry.js';
import { effectiveCatalog, type EffectiveDef } from './catalog.js';
import { getPreferences, memoryPreferences, putPreferences, type PreferenceStore } from './preferences.js';
import type { AgentLevel } from './registry.js';
import {
  PERFORMANCE_COLLECTIONS, PERFORMANCE_HIERARCHY_COLLECTION, PERFORMANCE_READ_TIMEOUT_MS,
  type PerformanceCollection, type PerformanceDatabaseKey,
} from '../config/performance.js';
import { PERFORMANCE_BREAKDOWN_MAPPING, PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from './performance-mapping.js';
import { metricBreakdowns } from './performance-breakdown.js';
import { sourceMetricScalar } from './performance-values.js';
import { changeFor } from './change.js';
import { performanceRecordMetadata, PerformanceSourceNotFound } from './performance-record.js';
import {
  assembleMonthlyHistory, checkMonthlyRange, MONTHLY_HISTORY_COLLECTIONS, MONTHLY_HISTORY_SOURCES, monthlyCandidates,
  type MonthlyHistoryInput,
} from './monthly-history.js';
import type { Lens } from './values.js';
import type {
  Basis,
  BusinessLine,
  Change,
  DrilldownBasis,
  MetricDetail,
  MetricScalar,
  MetricSeries,
  MetricSnapshot,
  Scope,
  SnapshotContext,
  TeamMember,
  TeamMemberDashboard,
  TeamMemberList,
  TeamSummaryTile,
  AgentOrganization,
  BarComparison,
  MonthlyHistory,
  MonthlyHistoryRequest,
} from '../types.js';

type Rows = Partial<Record<PerformanceCollection, Document>>;
type PerformanceDbs = Record<PerformanceDatabaseKey, Db>;
const HIERARCHY_PROJECTION = { _id: 1, asOnDate: 1, 'audit.updatedAt': 1, 'hierarchy.leaderId': 1, 'subtree.scopeProfileIds': 1, 'displayRows.tier': 1 };
const HIERARCHY_ORDER = { asOnDate: -1, 'audit.updatedAt': -1, _id: -1 } as const;
/** Marks an ID already looked up that has no hierarchy document (treated like an absent row). */
const ABSENT: Document = Object.freeze({});
/** Monthly history: whitelist only — no names, agent codes or vault data leave Mongo. Ties resolve `id` then `_id` descending (as `latest()`). */
const MONTHLY_PROJECTION = { _id: 0, id: 1, period: 1, asOnDate: 1, isMonthEnd: 1, agentAggregation: 1, ptd: 1 } as const;
const MONTHLY_ORDER = { 'period.year': 1, 'period.month': 1, id: -1, _id: -1 } as const;
/** Upper bound on a resolved downline so a malformed tree cannot fan out without limit. */
const MAX_DOWNLINE = 20_000;
/** Hierarchy snapshots change daily; one request resolves the caller's root up to three times. */
const HIERARCHY_ROOT_TTL_MS = 60_000;
const HIERARCHY_ROOT_CACHE_MAX = 1_000;
/** Source tiers vary in case and suffix across databases ('AM', 'UM', 'UM1', 'UM2', 'Agent', 'agent'). */
const levelForTier = (tier: unknown): AgentLevel | undefined => {
  const t = typeof tier === 'string' ? tier.trim().toUpperCase() : '';
  return t === 'AM' ? 'P2' : /^UM\d*$/.test(t) ? 'P3' : t === 'AGENT' ? 'P4' : undefined;
};
/** Short, secret-free category for a failed Mongo call (safe to log and to show in a 503). */
export function classifyMongoError(error: unknown): { category: 'timeout' | 'network' | 'authentication' | 'other'; hint?: string } {
  const e = error as { name?: string; code?: unknown; message?: string };
  const text = String(e?.message ?? '');
  if (e?.code === 50 || /timed? ?out|ETIMEDOUT|MaxTimeMSExpired|exceeded time limit/i.test(text)) return { category: 'timeout', hint: 'slow network or unindexed scan over the time limit' };
  if (e?.name === 'MongoServerSelectionError' || /ENOTFOUND|ECONNREFUSED|ECONNRESET|server selection|getaddrinfo|topology/i.test(text) || e?.name === 'MongoNetworkError') {
    return { category: 'network', hint: 'check the Atlas IP access list, VPN/firewall and MONGODB_URI' };
  }
  if (e?.code === 13 || e?.code === 18 || /auth|credentials|not authorized|Unauthorized/i.test(text)) return { category: 'authentication', hint: 'wrong user/password, or no rights on this database' };
  return { category: 'other' };
}
const BASIS_FOR_LEVEL: Record<AgentLevel, DrilldownBasis> = { P2: 'AM', P3: 'UM', P4: 'AGENT' };
/** Team Drilldown KPI tiles, in display order (C4 `summary.metrics`). */
const TEAM_KPI_CODES = ['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE'] as const;
/** Direct reportee IDs in source order, deduplicated, without the leader's own ID (UM/agent snapshots include it). */
const reportIdsOf = (row: Document | undefined): string[] => {
  const refs = row?.subtree?.scopeProfileIds;
  if (!Array.isArray(refs)) return [];
  const self = row?.hierarchy?.leaderId;
  return [...new Set(refs.filter((id: unknown): id is string => typeof id === 'string' && id !== self))];
};
const isoDate = (value: unknown): string | undefined => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
};
const at = (row: Document | undefined, path: string): unknown => path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Document)[key] : undefined, row);
const periodRank = (row: Document): number => performanceRecordMetadata(row).rank;
const zeroScalar = (kind: MetricDetail['valueType']): MetricScalar => kind === 'MONEY'
  ? { kind, amount: '0.00', currency: 'MYR' }
  : kind === 'COUNT' ? { kind, value: 0 }
    : kind === 'PERCENT' ? { kind, value: 0 }
      : { kind, value: 0, precision: 1 };
const isMissingMetricValue = (row: Document, path: string): boolean => {
  const value = at(row, path);
  return value === null || value === undefined;
};
const zeroChange = (code: string, kind: MetricDetail['valueType']): Change => {
  const base = { basis: 'LAST_YEAR' as const, direction: 'FLAT' as const, sentiment: 'NEUTRAL' as const };
  const display = effectiveCatalog('SELF', 'STANDARD').find(def => def.metricCode === code)?.changeDisplay;
  if (kind === 'MONEY') return display === 'ABS'
    ? { ...base, abs: { kind, amount: '0.00', currency: 'MYR' } }
    : { ...base, pct: 0 };
  if (kind === 'PERCENT') return display === 'PCT' ? { ...base, pct: 0 } : { ...base, pp: 0 };
  if (kind === 'COUNT') return display === 'ABS' ? { ...base, abs: { kind, value: 0 } } : { ...base, pct: 0 };
  return { ...base, pct: 0 };
};
/** SPEC-2026-002 0.5.0-draft: businessLine picks the database; `entity` is always the database's own
 * literal name ('PAMB' in PAMB, 'PBTB' in PBTB) on every row regardless of `agentType`. */
const databaseKeyFor = (businessLine: BusinessLine): PerformanceDatabaseKey => businessLine === 'TAKAFUL' ? 'PBTB' : 'PAMB';
/**
 * INTERIM (requester, 2026-09-29): `agentType` genuinely varies per agent (PAMB-only 'PAMB' vs also-Takaful-
 * licensed 'HYBRID' in the PAMB database), but real data has only one production row per agent/period, not
 * the two (one PAMB-tagged, one HYBRID-tagged) the requester expects the eventual source to supply. Filtering
 * `INSURANCE` to `agentType: 'PAMB'` therefore 404s every Hybrid-licensed agent under `INSURANCE`, since they
 * have no such row. Until the data team confirms the real two-record shape, `INSURANCE` and `ALL` both return
 * the same `entity`-matched row regardless of `agentType` — they are not yet distinguishable per-agent.
 * `entity` always equals the database key itself (`databaseKeyFor`), so no separate value table is needed.
 */
const entityFor = (businessLine: BusinessLine): string => databaseKeyFor(businessLine);

/** Guarded development adapter; no canonical/legacy collection fallback. */
export class PerformanceSource implements DataSource {
  readonly kind = 'performance' as const;
  readonly ownIdentityOnly = true;
  constructor(
    private readonly dbs: PerformanceDbs,
    private readonly agents: Map<string, AgentRecord>,
    private readonly log: (msg: string) => void = () => {},
    /** Kept for constructor compatibility; Mongo mode never reads from mock fallback data. */
    _deprecatedDevMockFallback = false,
    /** Kept for constructor compatibility; `my_agent_hierarchy` is always read. */
    _deprecatedHierarchyEnabled = false,
    /** Agent preferences; `createSource` passes the Mongo `metrics_preferences` store. */
    private readonly preferences: PreferenceStore = memoryPreferences,
  ) {
    if (!dbs.PAMB.databaseName || !dbs.PBTB.databaseName) throw new Error('Invalid Performance source database');
    void _deprecatedDevMockFallback;
    void _deprecatedHierarchyEnabled;
  }
  findAgent = (id: string): AgentRecord | undefined => this.agents.get(id);

  /**
   * One retry for transient connection problems (dropped socket, slow first connect), so a single
   * blip does not become a 503 on every dashboard call. Timeouts and auth errors are not retried:
   * they will not heal within a request.
   */
  private async withRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      const e = error as { name?: string; message?: string };
      const transient = e?.name === 'MongoNetworkError' || e?.name === 'MongoServerSelectionError' || e?.name === 'MongoNetworkTimeoutError'
        || /ECONNRESET|ECONNREFUSED|EPIPE|socket/i.test(String(e?.message ?? ''));
      if (!transient) throw error;
      this.log(`performance read retry: ${what} error=${e?.name ?? 'unknown'}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return run();
    }
  }

  /**
   * Server-side diagnostics for a failed Mongo read. Logs only the error class, driver code and a
   * category — never the driver message, which can carry hosts or credentials. Returns the short
   * category, which is also safe to show in the 503 so the cause is visible without server logs.
   */
  private logReadFailure(what: string, error: unknown): string {
    const { category, hint } = classifyMongoError(error);
    const e = error as { name?: string; code?: unknown; codeName?: string };
    this.log(`performance read FAILED: ${what} error=${e?.name ?? 'unknown'} code=${String(e?.code ?? e?.codeName ?? '-')} cause=${category}${hint ? ` (${hint})` : ''}`);
    return category;
  }

  /** Newest `my_agent_hierarchy` snapshot per leader ID (asOnDate DESC, audit.updatedAt DESC, _id DESC); names and vault data are never projected. */
  private async hierarchyRows(key: PerformanceDatabaseKey, ids: string[]): Promise<Map<string, Document>> {
    const out = new Map<string, Document>();
    if (!ids.length) return out;
    let docs: Document[];
    try {
      docs = await this.withRetry(`hierarchy read db=${key}`, () => this.dbs[key].collection(PERFORMANCE_HIERARCHY_COLLECTION).find(
        ids.length === 1 ? { 'hierarchy.leaderId': ids[0] } : { 'hierarchy.leaderId': { $in: ids } },
        { projection: HIERARCHY_PROJECTION, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS },
      ).sort(HIERARCHY_ORDER).toArray());
    } catch (error) {
      throw Object.assign(new Error('Hierarchy source read failed'), { sourceCause: this.logReadFailure(`hierarchy read db=${key} ids=${ids.length}`, error) });
    }
    for (const row of docs) {
      const id = row.hierarchy?.leaderId;
      if (typeof id === 'string' && !out.has(id)) out.set(id, row);
    }
    return out;
  }

  private readonly rootCache = new Map<string, { expires: number; value: Promise<{ key: PerformanceDatabaseKey; row: Document } | undefined> }>();

  /** Root lookup, memoized briefly: identity resolution and team visibility both need it on every request. */
  private hierarchyRoot(agentId: string): Promise<{ key: PerformanceDatabaseKey; row: Document } | undefined> {
    const now = Date.now();
    const hit = this.rootCache.get(agentId);
    if (hit && hit.expires > now) return hit.value;
    if (this.rootCache.size >= HIERARCHY_ROOT_CACHE_MAX) this.rootCache.clear();
    const value = this.loadHierarchyRoot(agentId);
    this.rootCache.set(agentId, { expires: now + HIERARCHY_ROOT_TTL_MS, value });
    value.catch(() => this.rootCache.delete(agentId));
    return value;
  }

  /** PAMB first, PBTB only when the root is absent; descendants resolve in the same database. */
  private async loadHierarchyRoot(agentId: string): Promise<{ key: PerformanceDatabaseKey; row: Document } | undefined> {
    for (const key of ['PAMB', 'PBTB'] as const) {
      const row = (await this.hierarchyRows(key, [agentId])).get(agentId);
      if (row) return { key, row };
    }
    return undefined;
  }

  private async listedAsReportee(agentId: string): Promise<boolean> {
    for (const key of ['PAMB', 'PBTB'] as const) {
      let rows: Document[];
      try {
        rows = await this.dbs[key].collection(PERFORMANCE_HIERARCHY_COLLECTION).find(
          { 'subtree.scopeProfileIds': agentId },
          { projection: { _id: 1 }, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS },
        ).limit(1).toArray();
      } catch (error) {
        throw Object.assign(new Error('Hierarchy source read failed'), { sourceCause: this.logReadFailure(`reportee lookup db=${key}`, error) });
      }
      if (rows.length) return true;
    }
    return false;
  }

  /**
   * Loads snapshots for IDs not yet in `rows`. IDs without a document are stored as `ABSENT`,
   * so a later walk does not query them again.
   */
  private async loadRows(key: PerformanceDatabaseKey, ids: string[], rows: Map<string, Document>): Promise<void> {
    const missing = [...new Set(ids)].filter(id => !rows.has(id));
    if (!missing.length) return;
    const found = await this.hierarchyRows(key, missing);
    for (const id of missing) rows.set(id, found.get(id) ?? ABSENT);
  }

  /** Every ID reachable from `ids` (inclusive), breadth-first with dedupe so cycles terminate. */
  private async downline(key: PerformanceDatabaseKey, ids: string[], rows: Map<string, Document>): Promise<Set<string>> {
    const seen = new Set(ids);
    let frontier = [...ids];
    while (frontier.length && seen.size < MAX_DOWNLINE) {
      await this.loadRows(key, frontier, rows);
      const next: string[] = [];
      for (const id of frontier) {
        for (const reportId of reportIdsOf(rows.get(id))) {
          if (!seen.has(reportId)) { seen.add(reportId); next.push(reportId); }
        }
      }
      frontier = next;
    }
    return seen;
  }

  async resolveIdentity(agentId: string): Promise<AgentRecord | undefined> {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return undefined;
    let root;
    try {
      root = await this.hierarchyRoot(agentId);
      // A reportee without its own snapshot is still a known agent (an ID-only leaf in its leader's tree).
      if (!root) return await this.listedAsReportee(agentId) ? { agentId, tenant: 'MY', level: 'P4', name: agentId } : undefined;
    } catch (error) {
      const sourceCause = (error as { sourceCause?: string })?.sourceCause ?? classifyMongoError(error).category;
      this.log(`identity lookup failed for a ${agentId.length}-char agent id (cause=${sourceCause})`);
      throw Object.assign(new Error('Identity hierarchy source read failed'), { sourceCause });
    }
    const level = levelForTier(root.row.displayRows?.tier);
    if (root.row.hierarchy?.leaderId !== agentId || !level) throw new Error('Malformed identity hierarchy');
    return { agentId, tenant: 'MY', level, name: agentId };
  }

  async getAgentOrganization(agentId: string): Promise<AgentOrganization | undefined> {
    try {
      const root = await this.hierarchyRoot(agentId);
      if (!root) return undefined;
      const { key } = root;
      const seen = new Set<string>();
      const build = async (id: string, row: Document | undefined, ancestors: Set<string>): Promise<AgentOrganization> => {
        if (ancestors.has(id)) throw new Error('Hierarchy cycle');
        seen.add(id);
        if (!row) return { agentId: id, displayName: id, reports: [] };
        const refs = row.subtree?.scopeProfileIds;
        if (row.hierarchy?.leaderId !== id || !Array.isArray(refs) || refs.some((value: unknown) => typeof value !== 'string')) throw new Error('Malformed hierarchy');
        const tier = levelForTier(row.displayRows?.tier);
        if (!tier) throw new Error('Malformed hierarchy');
        const next = new Set(ancestors).add(id);
        const reports: AgentOrganization[] = [];
        // UM/agent snapshots list the leader itself first; that entry is not a reportee.
        for (const reportId of reportIdsOf(row)) {
          if (ancestors.has(reportId)) throw new Error('Hierarchy cycle');
          if (seen.has(reportId)) continue;
          reports.push(await build(reportId, (await this.hierarchyRows(key, [reportId])).get(reportId), next));
        }
        return { agentId: id, displayName: id, tier, reports };
      };
      return await build(agentId, root.row, new Set());
    } catch (error) {
      if (error instanceof Error && ['Hierarchy cycle', 'Malformed hierarchy'].includes(error.message)) throw error;
      throw new Error('Hierarchy source read failed');
    }
  }

  private async latest(agent: AgentRecord, businessLine: BusinessLine, aggregation?: string): Promise<Rows> {
    if (agent.tenant !== 'MY' || !/^[A-Za-z0-9_-]{1,40}$/.test(agent.agentId)) throw new Error('Invalid Performance identity');
    const db = this.dbs[databaseKeyFor(businessLine)];
    const entity = entityFor(businessLine);
    const entries = await Promise.all(PERFORMANCE_COLLECTIONS.map(async name => {
      const keys = PERFORMANCE_SOURCE_KEYS[name];
      const query: Document = { [keys.identity]: agent.agentId, entity };
      if (aggregation) query[keys.aggregation] = aggregation;
      if (name === 'my_production') query[keys.caseStatus] = 'Collected';
      // Only fields necessary for mapping; names, identifiers and vault data never leave Mongo.
      let docs: Document[];
      try {
        docs = await db.collection(name).find(query, {
          projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
          maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
        }).sort({ 'period.year': -1, 'period.month': -1, id: -1, _id: -1 }).limit(1).toArray();
      } catch {
        // Driver messages can expose hosts, query arguments or credentials.
        throw new Error('Performance source read failed');
      }
      this.log(`performance read: agent=${agent.agentId} collection=${name} businessLine=${businessLine} aggregation=${aggregation ?? 'none'} found=${Boolean(docs[0])}`);
      if (docs[0]) performanceRecordMetadata(docs[0]);
      return [name, docs[0]] as const;
    }));
    return Object.fromEntries(entries.filter(([, row]) => row)) as Rows;
  }

  /**
   * `latest()` for many agents at once: one `$in` read per collection instead of three per agent.
   * Same filters and ordering; the first row seen per agent in the sorted result is its latest.
   */
  private async latestMany(agentIds: string[], businessLine: BusinessLine, aggregation: string): Promise<Map<string, Rows>> {
    const out = new Map<string, Rows>();
    const ids = [...new Set(agentIds)].filter(id => /^[A-Za-z0-9_-]{1,40}$/.test(id));
    if (!ids.length) return out;
    const db = this.dbs[databaseKeyFor(businessLine)];
    const entity = entityFor(businessLine);
    await Promise.all(PERFORMANCE_COLLECTIONS.map(async name => {
      const keys = PERFORMANCE_SOURCE_KEYS[name];
      const query: Document = { [keys.identity]: { $in: ids }, entity, [keys.aggregation]: aggregation };
      if (name === 'my_production') query[keys.caseStatus] = 'Collected';
      let docs: Document[];
      try {
        docs = await db.collection(name).find(query, {
          projection: { _id: 0, [keys.identity]: 1, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
          maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
        }).sort({ 'period.year': -1, 'period.month': -1, id: -1, _id: -1 }).toArray();
      } catch {
        throw new Error('Performance source read failed');
      }
      for (const row of docs) {
        const id = String(row[keys.identity]);
        const rows = out.get(id) ?? {};
        if (rows[name]) continue;
        performanceRecordMetadata(row);
        rows[name] = row;
        out.set(id, rows);
      }
    }));
    this.log(`performance batch read: agents=${ids.length} businessLine=${businessLine} aggregation=${aggregation} found=${out.size}`);
    return out;
  }

  /**
   * Same identity/aggregation/type as `latest()`, restricted to one collection and one prior
   * reporting month. Picks the closest-not-exceeding `asOnMonthDay` (undeclared ⇒ month-end, same
   * convention `selection()` uses) so a still-partial current month is never compared against an
   * already-closed prior-year month — no row at or before that day ⇒ undefined, comparison unavailable.
   */
  private async priorYearRow(
    agent: AgentRecord, businessLine: BusinessLine, aggregation: string | undefined,
    collection: PerformanceCollection, year: number, month: number, notAfterDay: number,
  ): Promise<Document | undefined> {
    if (agent.tenant !== 'MY' || !/^[A-Za-z0-9_-]{1,40}$/.test(agent.agentId)) throw new Error('Invalid Performance identity');
    const db = this.dbs[databaseKeyFor(businessLine)];
    const entity = entityFor(businessLine);
    const keys = PERFORMANCE_SOURCE_KEYS[collection];
    const query: Document = { [keys.identity]: agent.agentId, entity, 'period.year': year, 'period.month': month };
    if (aggregation) query[keys.aggregation] = aggregation;
    if (collection === 'my_production') query[keys.caseStatus] = 'Collected';
    let docs: Document[];
    try {
      docs = await db.collection(collection).find(query, {
        projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
        maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
      }).sort({ id: -1, _id: -1 }).toArray();
    } catch {
      throw new Error('Performance source read failed');
    }
    const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const eligible = docs
      .map(row => ({ row, day: performanceRecordMetadata(row).day ?? monthEnd }))
      .filter(({ day }) => day <= notAfterDay)
      .sort((a, b) => b.day - a.day);
    return eligible[0]?.row;
  }

  /** Several catalog metrics share one collection (e.g. TPC/PTPC/FYP/FYC/CASE_COUNT all read my_production) — cache per request so metricList doesn't re-query the same collection once per metric. */
  private priorYearRowCached(
    cache: Map<string, Promise<Document | undefined>>,
    agent: AgentRecord, businessLine: BusinessLine, aggregation: string | undefined,
    collection: PerformanceCollection, year: number, month: number, notAfterDay: number,
  ): Promise<Document | undefined> {
    const key = `${collection}|${year}|${month}|${notAfterDay}|${aggregation ?? ''}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = this.priorYearRow(agent, businessLine, aggregation, collection, year, month, notAfterDay);
      cache.set(key, promise);
    }
    return promise;
  }

  private async selection(agent: AgentRecord, lens: Lens): Promise<{ rows: Rows; context: SnapshotContext; year: number; month: number; day: number; aggregation?: string }> {
    // v0.4.0-draft: businessLine is always routed to a real database now (see databaseKeyFor/agentTypeFor).
    // TEAM aggregates by teamView: DIRECT -> 'DirectUnit', GROUP -> 'Group' (both confirmed present in
    // Mongo agentAggregation values, camelCase across all three collections). SCHEME basis remains an unsupported placeholder
    // (OQ-20, see catalog.ts) and still gates to EMPTY.
    const basisSupported = lens.basis === 'STANDARD';
    const aggregation = lens.scope === 'SELF' ? 'Personal' : lens.teamView === 'GROUP' ? 'Group' : 'DirectUnit';
    const withAggregation = await this.latest(agent, lens.businessLine, aggregation);
    const found = Object.values(withAggregation).length > 0;
    const contexts = found ? withAggregation : await this.latest(agent, lens.businessLine);
    const all = Object.values(contexts);
    if (!all.length) throw new PerformanceSourceNotFound();
    const rank = Math.max(...all.map(periodRank));
    const current = all.filter(row => periodRank(row) === rank);
    const first = current[0]!;
    const { year, month } = performanceRecordMetadata(first);
    const declaredDay = current.map(row => performanceRecordMetadata(row).day).find(day => day !== undefined);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = declaredDay ?? lastDay;
    const startMonth = lens.period === 'YTD' ? 1 : lens.period === 'QTD' ? Math.floor((month - 1) / 3) * 3 + 1 : month;
    const date = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const rows: Rows = basisSupported ? Object.fromEntries(Object.entries(withAggregation).filter(([, row]) => periodRank(row!) === rank)) : {};
    return {
      rows, year, month, day, aggregation: found ? aggregation : undefined,
      context: { period: { type: lens.period, startDate: date(startMonth, 1), endDate: date(month, day) },
        businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope,
        ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
        // v0.4.0-draft (AC-PA-DIRECT-29): asOfDate is the period end date, never the asOnDate watermark.
        asOfDate: date(month, day) },
    };
  }


  private value(def: EffectiveDef, rows: Rows, lens: Lens, repriced = false): MetricScalar | undefined {
    const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
    if (!mapping || mapping.valueType !== def.valueType) return undefined;
    const path = performanceMetricPath(mapping, lens.period, repriced);
    return path ? sourceMetricScalar(def.valueType, at(rows[mapping.collection], path), mapping.fraction) : undefined;
  }

  /** Same identity/aggregation as the current-period read, one year back, day-aligned per `priorYearRow()`. `cache` de-dupes reads across metrics sharing a collection within one request (see `priorYearRowCached`). */
  private async comparisonFor(
    def: EffectiveDef, agent: AgentRecord, lens: Lens, current: MetricScalar,
    year: number, month: number, day: number, aggregation: string | undefined,
    cache: Map<string, Promise<Document | undefined>>,
  ): Promise<{ current: MetricScalar; prior: MetricScalar; priorYear: number; change: Change } | undefined> {
    const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
    if (!mapping) return undefined;
    const priorRow = await this.priorYearRowCached(cache, agent, lens.businessLine, aggregation, mapping.collection, year - 1, month, day);
    if (!priorRow) return undefined;
    const path = performanceMetricPath(mapping, lens.period);
    if (path && isMissingMetricValue(priorRow, path)) {
      const prior = zeroScalar(def.valueType);
      return { current, prior, priorYear: year - 1, change: zeroChange(def.metricCode, def.valueType) };
    }
    const prior = this.value(def, { [mapping.collection]: priorRow } as Rows, lens);
    if (prior) return { current, prior, priorYear: year - 1, change: changeFor(def.metricCode, current, prior) };
    return undefined;
  }

  async metricList(agent: AgentRecord, lens: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) {
    const { rows, context } = await this.selection(agent, lens);
    const items = effectiveCatalog(lens.scope, lens.basis)
      .filter(def => codes?.length ? codes.includes(def.metricCode) : listScope === 'ALL' || def.effCategory === listScope)
      .map((def): MetricSnapshot => {
        const collected = this.value(def, rows, lens);
        return { metricCode: def.metricCode, valueType: def.valueType, asOfDate: context.asOfDate,
          ...(def.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' as const } : {}),
          dataState: collected ? 'OK' : 'EMPTY', ...(collected ? { collected, goal: { state: 'NOT_SET' as const } } : {}) };
      });
    return { context, items };
  }
  async metricDetail(agent: AgentRecord, code: string, lens: Lens): Promise<MetricDetail | undefined> {
    const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
    if (!def) return undefined;
    const { rows, context, year, month, day, aggregation } = await this.selection(agent, lens);
    const priorYear = year - 1;
    const collected = this.value(def, rows, lens);
    const isPersistency = ['PERSISTENCY_CY', 'PERSISTENCY_Y1', 'PERSISTENCY_Y2'].includes(code);
    const cache = new Map<string, Promise<Document | undefined>>();
    const found = collected ? await this.comparisonFor(def, agent, lens, collected, year, month, day, aggregation, cache) : undefined;
    // Persistency shows its prior-year value only when a real prior row exists (never a zero stand-in);
    // other metrics keep the neutral zero prior when the prior row is absent.
    const comparison = collected
      ? (isPersistency ? found : found ?? { current: collected, prior: zeroScalar(def.valueType), priorYear, change: zeroChange(code, def.valueType) })
      : undefined;
    const barComparison = collected && comparison && def.capabilities.barComparison
      ? await this.barComparisonFor(def, agent, lens, rows, collected, comparison, { year, month, day, aggregation, cache })
      : undefined;
    const alt = collected && def.capabilities.repricing ? this.value(def, rows, lens, true) : undefined;
    // Breakdown by product: the same `my_production` row and period as the headline value (TPC/PTPC/FYP).
    const breakdowns = collected && def.capabilities.breakdown
      ? metricBreakdowns(code, rows[PERFORMANCE_BREAKDOWN_MAPPING[code]?.collection ?? 'my_production'], lens.period, lens.businessLine)
      : [];
    const detail: MetricDetail = { metricCode: code, valueType: def.valueType, context, dataState: collected ? 'OK' : 'EMPTY',
      ...(collected ? { primary: { variant: 'WITHOUT_REPRICING' as const, collected } } : {}),
      ...(alt ? { altVariants: [{ variant: 'WITH_REPRICING' as const, collected: alt }] } : {}),
      ...(comparison ? { comparison } : {}),
      ...(breakdowns.length ? { breakdowns } : {}),
      ...(barComparison ? { barComparison } : {}),
      ...(collected && def.threshold ? { threshold: def.threshold } : {}) };
    return detail;
  }

  /**
   * Prior-year vs current bars from the same rows as the comparison (Figma Metric Drill downs).
   * GROUPED: one measure, chip on the current bar = the absolute change. STACKED (MANPOWER):
   * existing agents + new recruits (`my_mapa` newRecruits, same period rules), totals carry the chip.
   * Returns undefined when a needed value is unavailable, so the detail falls back to the gauge.
   */
  private async barComparisonFor(
    def: EffectiveDef, agent: AgentRecord, lens: Lens, rows: Rows, current: MetricScalar,
    comparison: { current: MetricScalar; prior: MetricScalar; priorYear: number; change: Change },
    at: { year: number; month: number; day: number; aggregation: string | undefined; cache: Map<string, Promise<Document | undefined>> },
  ): Promise<BarComparison | undefined> {
    const years = [comparison.priorYear, at.year];
    const diff = (cur: MetricScalar, pri: MetricScalar): MetricScalar | undefined => {
      if (cur.kind === 'COUNT' && pri.kind === 'COUNT') return { kind: 'COUNT', value: cur.value - pri.value };
      if (cur.kind === 'DECIMAL' && pri.kind === 'DECIMAL') return { kind: 'DECIMAL', value: Number((cur.value - pri.value).toFixed(1)), precision: 1 };
      return undefined;
    };
    if (def.metricCode === 'MANPOWER') {
      if (current.kind !== 'COUNT' || comparison.prior.kind !== 'COUNT') return undefined;
      const recruitsDef = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === 'NEW_RECRUIT_CONTRACTED');
      const recruitsNow = recruitsDef ? this.value(recruitsDef, rows, lens) : undefined;
      if (!recruitsDef || recruitsNow?.kind !== 'COUNT') return undefined;
      const recruitsThen = await this.comparisonFor(recruitsDef, agent, lens, recruitsNow, at.year, at.month, at.day, at.aggregation, at.cache);
      // No prior-year row at all ⇒ the same neutral zero prior the comparison card uses.
      const recruitsBefore = recruitsThen?.prior.kind === 'COUNT' ? recruitsThen.prior.value : 0;
      const split = (total: number, recruits: number): [MetricScalar, MetricScalar] => {
        const r = Math.max(0, Math.min(total, recruits));
        return [{ kind: 'COUNT', value: total - r }, { kind: 'COUNT', value: r }];
      };
      const [curExisting, curRecruits] = split(current.value, recruitsNow.value);
      const [priExisting, priRecruits] = split(comparison.prior.value, recruitsBefore);
      return {
        years, axis: { unitCode: 'AGENTS' }, layout: 'STACKED',
        measures: [
          { measureCode: 'EXISTING_AGENTS', points: [{ year: years[0]!, value: priExisting }, { year: years[1]!, value: curExisting }] },
          { measureCode: 'NEW_RECRUITS', points: [{ year: years[0]!, value: priRecruits }, { year: years[1]!, value: curRecruits }] },
        ],
        totals: [{ year: years[0]!, value: comparison.prior }, { year: years[1]!, value: current, change: comparison.change }],
      };
    }
    const abs = diff(current, comparison.prior);
    if (!abs) return undefined;
    return {
      years,
      measures: [{ points: [
        { year: years[0]!, value: comparison.prior },
        { year: years[1]!, value: current, change: { basis: 'LAST_YEAR', direction: comparison.change.direction, sentiment: comparison.change.sentiment, abs } },
      ] }],
    };
  }
  async metricSeries(agent: AgentRecord, code: string, lens: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined> {
    const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
    if (!def?.capabilities.history) return undefined;
    const { context } = await this.selection(agent, lens);
    const seriesContext = { businessLine: context.businessLine, basis: context.basis, scope: context.scope,
      ...(context.teamView ? { teamView: context.teamView } : {}), asOfDate: context.asOfDate };
    // The source collections have no monthly history; return null points rather than synthetic values.
    return { metricCode: code, valueType: def.valueType, context: seriesContext, anchorYear,
      series: Array.from({ length: yearsBack + 1 }, (_, offset) => ({ year: anchorYear - offset,
        points: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, value: null })) })) };
  }
  /**
   * Monthly history (ARVIJ-1450, docs/monthly-history-source.md): both databases x `my_production`/`my_mapa`, four reads
   * in parallel, each bounded by `maxTimeMS` with one transient retry. Rows outside the month range or with malformed
   * period/asOnDate metadata are dropped (counted in the log, never their content). There is no aggregation fallback.
   */
  async monthlyHistory(agent: AgentRecord, req: MonthlyHistoryRequest): Promise<MonthlyHistory> {
    if (agent.tenant !== 'MY' || !/^[A-Za-z0-9_-]{1,40}$/.test(agent.agentId)) throw new Error('Invalid Performance identity');
    const range = checkMonthlyRange(req.from, req.to);
    if (!range.ok) throw new Error('Invalid monthly history range');
    const jobs = MONTHLY_HISTORY_SOURCES.flatMap(source => MONTHLY_HISTORY_COLLECTIONS.map(collection => ({ source, collection })));
    const inputs = await Promise.all(jobs.map(async ({ source, collection }): Promise<MonthlyHistoryInput> => {
      const keys = PERFORMANCE_SOURCE_KEYS[collection];
      // `entity` is the database's own literal ('PAMB' in PAMB, 'PBTB' in PBTB). The year range is a coarse index-friendly
      // filter; months are filtered in code because period.yyyymm is spelled differently across collections.
      const query: Document = { [keys.identity]: agent.agentId, entity: source, 'period.year': { $gte: range.from.year, $lte: range.to.year } };
      if (req.aggregation) query[keys.aggregation] = req.aggregation;
      if (collection === 'my_production') query[keys.caseStatus] = 'Collected';
      const what = `monthly history read db=${source} collection=${collection}`;
      let docs: Document[];
      try {
        docs = await this.withRetry(what, () => this.dbs[source].collection(collection).find(query, {
          projection: MONTHLY_PROJECTION, maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
        }).sort(MONTHLY_ORDER).toArray());
      } catch (error) {
        throw Object.assign(new Error('Monthly history source read failed'), { sourceCause: this.logReadFailure(what, error) });
      }
      const { candidates, skipped } = monthlyCandidates(docs, range.from, range.to);
      this.log(`performance read: monthly history db=${source} collection=${collection} aggregation=${req.aggregation ?? 'any'} rows=${docs.length} inRange=${candidates.length} skipped=${skipped}`);
      return { source, collection, candidates };
    }));
    return assembleMonthlyHistory(agent.agentId, req.from, req.to, inputs);
  }
  async milestones(agent: AgentRecord) {
    const { context } = await this.selection(agent, { period: 'YTD', scope: 'SELF', basis: 'STANDARD', businessLine: 'INSURANCE' });
    return { asOfDate: context.asOfDate, items: [] };
  }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return getPreferences(this.preferences, agent.tenant, agent.agentId, scope, basis); }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(this.preferences, agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord, _scope: Scope = 'SELF') {
    void agent;
    const { asOfDate } = await this.milestones(agent);
    return { items: [], generatedAt: `${asOfDate}T00:00:00Z` };
  }
  async recordFeedback(_agent?: AgentRecord, _recommendationId?: string, _rating?: 'UP' | 'DOWN') {
    return false;
  }

  /** Member card from its hierarchy snapshot (absent ⇒ ID-only AGENT leaf); names stay encrypted in Mongo, so the ID is the display name. */
  private memberOf(agentId: string, row: Document | undefined): { member: TeamMember; record: AgentRecord } {
    const level = levelForTier(row?.displayRows?.tier) ?? 'P4';
    const basis = BASIS_FOR_LEVEL[level];
    const reports = reportIdsOf(row).length;
    return {
      member: { agentId, displayName: agentId, hierarchyBasis: basis, roleCode: basis, ...(reports ? { directReportCount: reports } : {}) },
      record: { agentId, tenant: 'MY', level, name: agentId },
    };
  }

  /**
   * Personal TPC/PTPC for many members from one batched read. Values match the member's own
   * dashboard: only rows of the newest period across the collections count (as in `selection()`),
   * and a member without rows keeps the cards empty (never zero-filled).
   */
  private async withProduction(members: TeamMember[], lens: Lens): Promise<TeamMember[]> {
    if (!members.length || lens.basis !== 'STANDARD') return members;
    const byAgent = await this.latestMany(members.map(m => m.agentId), lens.businessLine, 'Personal');
    const selfLens: Lens = { ...lens, scope: 'SELF' };
    const defs = effectiveCatalog('SELF', lens.basis).filter(d => d.metricCode === 'TPC' || d.metricCode === 'PTPC');
    return members.map(member => {
      const all = byAgent.get(member.agentId);
      if (!all) return member;
      const rank = Math.max(...Object.values(all).map(row => periodRank(row!)));
      const rows = Object.fromEntries(Object.entries(all).filter(([, row]) => periodRank(row!) === rank)) as Rows;
      const out = { ...member };
      for (const def of defs) {
        const value = this.value(def, rows, selfLens);
        if (value) out[def.metricCode === 'TPC' ? 'tpc' : 'ptpc'] = value;
      }
      return out;
    });
  }

  /** D-14 visibility from `my_agent_hierarchy`: P3 sees its direct team only; P2 its whole downline. */
  private async visibleTeam(agent: AgentRecord): Promise<{ key: PerformanceDatabaseKey; root: Document; direct: string[]; visible: Set<string>; rows: Map<string, Document> } | undefined> {
    const found = await this.hierarchyRoot(agent.agentId);
    if (!found) return undefined;
    const rows = new Map([[agent.agentId, found.row]]);
    const direct = reportIdsOf(found.row);
    const visible = agent.level === 'P2' ? await this.downline(found.key, direct, rows) : new Set(direct);
    visible.delete(agent.agentId);
    return { key: found.key, root: found.row, direct, visible, rows };
  }

  /**
   * Direct reports from `my_agent_hierarchy` (`subtree.scopeProfileIds`), card
   * TPC/PTPC from `my_production`. Badges, goal status and photos have no
   * approved source (OQ-79) and are omitted; a badge filter therefore matches
   * nobody. MANPOWER counts the filtered members' organisations; tiles without
   * a source stay value-less.
   */
  async listTeamMembers(agent: AgentRecord, req: TeamListRequest): Promise<TeamMemberList | undefined> {
    const team = await this.visibleTeam(agent);
    if (req.parentMemberAgentId && !team?.visible.has(req.parentMemberAgentId)) return undefined;
    if (team && req.parentMemberAgentId) {
      await this.loadRows(team.key, [req.parentMemberAgentId], team.rows);
    }
    const ownerId = req.parentMemberAgentId ?? agent.agentId;
    const ownerRow = team?.rows.get(ownerId);
    const ids = ownerId === agent.agentId ? team?.direct ?? [] : reportIdsOf(ownerRow);
    if (team) await this.loadRows(team.key, ids, team.rows);

    const needle = req.query?.trim().toLowerCase() ?? '';
    const candidates = ids
      .map(id => this.memberOf(id, team?.rows.get(id)).member)
      .filter(member => !req.basis || member.hierarchyBasis === req.basis)
      .filter(member => !needle || member.agentId.toLowerCase().includes(needle))
      .filter(() => !req.badges?.length);
    const parentMember = req.parentMemberAgentId && team ? this.memberOf(ownerId, ownerRow).member : undefined;

    // Independent reads run together: one batched metric read (members + drawer parent),
    // the MANPOWER downline walk, and the caller's reporting date.
    const filtered = Boolean(req.basis || needle || req.badges?.length);
    const [enriched, summary, asOfDate] = await Promise.all([
      this.withProduction(parentMember ? [...candidates, parentMember] : candidates, req.lens),
      parentMember ? Promise.resolve(undefined)
        : filtered ? this.filteredSummary(team, candidates.map(m => m.agentId))
          : this.teamKpis(agent, req),
      this.teamAsOfDate(agent, req.lens, team?.root),
    ]);
    const parent = parentMember ? enriched.pop() : undefined;
    const items = enriched;
    const amount = (m: TeamMember) => {
      const v = req.sortBy === 'PTPC' ? m.ptpc : m.tpc;
      return v?.kind === 'MONEY' ? Number(v.amount) : Number.NEGATIVE_INFINITY;
    };
    items.sort((a, b) => amount(b) - amount(a) || a.agentId.localeCompare(b.agentId));

    return {
      asOfDate,
      ...(req.basis ? { basis: req.basis } : {}),
      items,
      ...(parent ? { parent } : { summary }),
    };
  }

  /**
   * Unfiltered KPI tiles: the caller's own team row in `my_mapa` (DirectUnit, or Group for
   * teamView=GROUP), so the tiles equal the Team dashboard's Manpower / Activity Ratio /
   * Productivity / Average Case Size. No team row ⇒ tiles without values.
   */
  private async teamKpis(agent: AgentRecord, req: TeamListRequest): Promise<TeamSummaryTile[]> {
    const lens: Lens = { ...req.lens, scope: 'TEAM', teamView: req.teamView };
    let rows: Rows = {};
    try { rows = (await this.selection(agent, lens)).rows; }
    catch (error) { if (!(error instanceof PerformanceSourceNotFound)) throw error; }
    const defs = new Map(effectiveCatalog('TEAM', lens.basis).map(def => [def.metricCode, def]));
    return TEAM_KPI_CODES.map((metricCode) => {
      const def = defs.get(metricCode);
      const value = def ? this.value(def, rows, lens) : undefined;
      return { metricCode, ...(value ? { value } : {}) };
    });
  }

  /**
   * Filtered KPI tiles: no source carries KPIs for an arbitrary member subset, so only
   * MANPOWER is derivable — the filtered members plus their hierarchy downlines.
   */
  private async filteredSummary(team: Awaited<ReturnType<PerformanceSource['visibleTeam']>>, ids: string[]): Promise<TeamSummaryTile[]> {
    const org = team ? await this.downline(team.key, ids, team.rows) : new Set<string>();
    return TEAM_KPI_CODES.map((metricCode) => metricCode === 'MANPOWER'
      ? { metricCode, value: { kind: 'COUNT' as const, value: org.size } }
      : { metricCode });
  }

  /** The caller's reporting-period end when it has metric rows, otherwise the hierarchy snapshot date. */
  private async teamAsOfDate(agent: AgentRecord, lens: Lens, root: Document | undefined): Promise<string> {
    try {
      return (await this.selection(agent, { ...lens, scope: 'SELF' })).context.asOfDate;
    } catch (error) {
      if (!(error instanceof PerformanceSourceNotFound)) throw error;
    }
    const date = isoDate(root?.asOnDate);
    if (!date) throw new PerformanceSourceNotFound();
    return date;
  }

  async findTeamMember(agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<{ member: TeamMember; record: AgentRecord } | undefined> {
    const team = await this.visibleTeam(agent);
    if (!team?.visible.has(memberAgentId)) return undefined;
    await this.loadRows(team.key, [memberAgentId], team.rows);
    const row = team.rows.get(memberAgentId);
    const { member, record } = this.memberOf(memberAgentId, row);
    const [withValues] = await this.withProduction([member], lens);
    return { member: withValues!, record };
  }

  async getTeamMemberDashboard(agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<TeamMemberDashboard | undefined> {
    const found = memberAgentId === agent.agentId ? undefined : await this.findTeamMember(agent, memberAgentId, lens);
    if (memberAgentId !== agent.agentId && !found) return undefined;
    const subject = found?.record ?? agent;
    const list = await this.metricList(subject, { ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
    return {
      member: found?.member ?? {
        agentId: agent.agentId,
        displayName: agent.name,
        hierarchyBasis: BASIS_FOR_LEVEL[agent.level],
        roleCode: BASIS_FOR_LEVEL[agent.level],
      },
      context: {
        period: list.context.period,
        businessLine: list.context.businessLine,
        basis: list.context.basis,
        scope: 'SELF',
        asOfDate: list.context.asOfDate,
      },
      metrics: list.items,
    };
  }
}