import type { Db, Document } from 'mongodb';
import type { DataSource, TeamListRequest } from './source.js';
import type { AgentRecord } from './registry.js';
import { effectiveCatalog, type EffectiveDef } from './catalog.js';
import { getPreferences, putPreferences } from './preferences.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DATABASES, PERFORMANCE_READ_TIMEOUT_MS, type PerformanceCollection, type PerformanceDatabaseKey } from '../config/performance.js';
import { PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from './performance-mapping.js';
import { sourceMetricScalar } from './performance-values.js';
import { performanceRecordMetadata, PerformanceSourceNotFound } from './performance-record.js';
import {
  contextFor, metricList as stubMetricList, metricSeries as stubMetricSeries, milestones as stubMilestones, mockFillDetail, type Lens,
} from './values.js';
import { recommendations as stubRecommendations, recordFeedback as stubRecordFeedback } from './recommendations.js';
import { mockTeamMemberDashboard, mockTeamMembers } from './mocks/team-members.js';
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
  TeamMemberDashboard,
  TeamMemberList,
} from '../types.js';
import { mockTeamPendersCaseCount } from './mocks/team-penders.js';

type Rows = Partial<Record<PerformanceCollection, Document>>;
type PerformanceDbs = Record<PerformanceDatabaseKey, Db>;
const at = (row: Document | undefined, path: string): unknown => path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Document)[key] : undefined, row);
const periodRank = (row: Document): number => performanceRecordMetadata(row).rank;
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
    /**
     * DEV-ONLY opt-in (`INSIGHTS_DEV_MOCK_FALLBACK=true` + `NODE_ENV=development`):
     * Mongo first; anything it cannot supply is filled from the stub engine. Real values are never replaced.
     */
    private readonly devMockFallback = false,
  ) {
    if (dbs.PAMB.databaseName !== PERFORMANCE_DATABASES.PAMB || dbs.PBTB.databaseName !== PERFORMANCE_DATABASES.PBTB) {
      throw new Error('Invalid Performance source database');
    }
  }
  findAgent = (id: string): AgentRecord | undefined => this.agents.get(id);

  private async latest(agent: AgentRecord, businessLine: BusinessLine, aggregation?: string): Promise<Rows> {
    if (agent.tenant !== 'MY' || !this.agents.has(agent.agentId)) throw new Error('Identity not allowed in Performance profile');
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
   * Same identity/aggregation/type as `latest()`, restricted to one collection and one prior
   * reporting month. Picks the closest-not-exceeding `asOnMonthDay` (undeclared ⇒ month-end, same
   * convention `selection()` uses) so a still-partial current month is never compared against an
   * already-closed prior-year month — no row at or before that day ⇒ undefined, comparison unavailable.
   */
  private async priorYearRow(
    agent: AgentRecord, businessLine: BusinessLine, aggregation: string | undefined,
    collection: PerformanceCollection, year: number, month: number, notAfterDay: number,
  ): Promise<Document | undefined> {
    if (agent.tenant !== 'MY' || !this.agents.has(agent.agentId)) throw new Error('Identity not allowed in Performance profile');
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

  /** `selection`, but with the DEV fallback an agent with no Mongo rows gets the stub context instead of a 404. */
  private async selectionOrMock(agent: AgentRecord, lens: Lens): Promise<{ rows: Rows; context: SnapshotContext }> {
    try {
      return await this.selection(agent, lens);
    } catch (error) {
      if (!this.devMockFallback || !(error instanceof PerformanceSourceNotFound)) throw error;
      this.log(`performance DEV MOCK fallback: agent=${agent.agentId} no source rows, using stub context`);
      return { rows: {}, context: contextFor(lens) };
    }
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
    const prior = this.value(def, { [mapping.collection]: priorRow } as Rows, lens);
    return prior ? { current, prior, priorYear: year - 1, change: changeFor(def.metricCode, current, prior) } : undefined;
  }

  async metricList(agent: AgentRecord, lens: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) {
    const { rows, context } = await this.selectionOrMock(agent, lens);
    const items = effectiveCatalog(lens.scope, lens.basis)
      .filter(def => codes?.length ? codes.includes(def.metricCode) : listScope === 'ALL' || def.effCategory === listScope)
      .map((def): MetricSnapshot => {
        const collected = this.value(def, rows, lens);
        return { metricCode: def.metricCode, valueType: def.valueType, asOfDate: context.asOfDate,
          ...(def.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' as const } : {}),
          dataState: collected ? 'OK' : 'EMPTY', ...(collected ? { collected, goal: { state: 'NOT_SET' as const } } : {}) };
      });
    if (!this.devMockFallback) return { context, items };
    const stub = new Map(stubMetricList(lens, listScope, codes).items.map(item => [item.metricCode, item]));
    const filled: string[] = [];
    const merged = items.map((item) => {
      const mock = item.dataState === 'EMPTY' ? stub.get(item.metricCode) : undefined;
      if (!mock) return item;
      filled.push(item.metricCode);
      return { ...mock, dataState: 'OK' as const, asOfDate: context.asOfDate };
    });
    if (filled.length) this.log(`performance DEV MOCK fallback: agent=${agent.agentId} list filled=${filled.join(',')}`);
    return { context, items: merged };
  }
  async metricDetail(agent: AgentRecord, code: string, lens: Lens): Promise<MetricDetail | undefined> {
    const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
    if (!def) return undefined;
    const { rows, context } = await this.selectionOrMock(agent, lens);
    const collected = this.value(def, rows, lens);
    const alt = collected && def.capabilities.repricing ? this.value(def, rows, lens, true) : undefined;
    // v1.7.0 (AC-P4-02-32) / v1.20.0 (AC-P4-02-58): Penders case count for TPC/PTPC at SELF
    // and TEAM. No collection here materializes this yet (mongodb.md v1.7.0 D-19, OQ-77) —
    // mock-sourced until it does, same interim source as the stub engine in values.ts; never
    // derived from a money field.
    const pendersCaseCount = collected && def.capabilities.repricing
      ? mockTeamPendersCaseCount(code, lens.scope === 'TEAM' ? (lens.teamView ?? 'DIRECT') : 'SELF')
      : undefined;
    const detail: MetricDetail = { metricCode: code, valueType: def.valueType, context, dataState: collected ? 'OK' : 'EMPTY',
      ...(collected ? { primary: { variant: 'WITHOUT_REPRICING' as const, collected } } : {}),
      ...(alt ? { altVariants: [{ variant: 'WITH_REPRICING' as const, collected: alt }] } : {}),
      ...(comparison ? { comparison } : {}),
      ...(collected && def.threshold ? { threshold: def.threshold } : {}),
      ...(pendersCaseCount !== undefined ? { pendersCaseCount } : {}) };
    if (!this.devMockFallback) return detail;
    const { detail: filledDetail, filled } = mockFillDetail(code, lens, detail);
    if (filled.length) this.log(`performance DEV MOCK fallback: agent=${agent.agentId} metric=${code} filled=${filled.join(',')}`);
    return filledDetail;
  }
  async metricSeries(agent: AgentRecord, code: string, lens: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined> {
    const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
    if (!def?.capabilities.history) return undefined;
    const { context } = await this.selectionOrMock(agent, lens);
    const seriesContext = { businessLine: context.businessLine, basis: context.basis, scope: context.scope,
      ...(context.teamView ? { teamView: context.teamView } : {}), asOfDate: context.asOfDate };
    // No source collection materializes monthly history; the DEV fallback supplies the stub series.
    const stub = this.devMockFallback ? stubMetricSeries(code, lens, anchorYear, yearsBack) : undefined;
    if (stub) {
      this.log(`performance DEV MOCK fallback: agent=${agent.agentId} metric=${code} filled=history`);
      return { ...stub, context: seriesContext };
    }
    return { metricCode: code, valueType: def.valueType, context: seriesContext, anchorYear,
      series: Array.from({ length: yearsBack + 1 }, (_, offset) => ({ year: anchorYear - offset,
        points: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, value: null })) })) };
  }
  async milestones(agent: AgentRecord) {
    const { context } = await this.selectionOrMock(agent, { period: 'YTD', scope: 'SELF', basis: 'STANDARD', businessLine: 'INSURANCE' });
    if (!this.devMockFallback) return { asOfDate: context.asOfDate, items: [] };
    this.log(`performance DEV MOCK fallback: agent=${agent.agentId} filled=milestones`);
    return { ...stubMilestones(), asOfDate: context.asOfDate };
  }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord, scope: Scope = 'SELF') {
    if (this.devMockFallback) {
      this.log(`performance DEV MOCK fallback: agent=${agent.agentId} filled=recommendations`);
      return stubRecommendations(agent.agentId, scope);
    }
    const { asOfDate } = await this.milestones(agent);
    return { items: [], generatedAt: `${asOfDate}T00:00:00Z` };
  }
  async recordFeedback(agent?: AgentRecord, recommendationId?: string, rating?: 'UP' | 'DOWN') {
    if (!this.devMockFallback || !agent || !recommendationId || !rating) return false;
    return stubRecordFeedback(agent.agentId, recommendationId, rating);
  }

  /**
   * The three approved collections carry no hierarchy, badges, goal status or
   * direct-report counts (spec OQ-79): the list stays the caller's own row, card
   * fields are omitted, KPI tiles carry no values, and no subteam is visible.
   */
  async listTeamMembers(agent: AgentRecord, req: TeamListRequest): Promise<TeamMemberList | undefined> {
    if (req.parentMemberAgentId) return undefined;
    const basis = req.basis ?? 'AGENT';
    const normalized = req.query?.trim().toLowerCase() ?? '';
    const items: TeamMemberList['items'] = [{ agentId: agent.agentId, displayName: agent.name, roleCode: basis }]
      .filter((m) => !normalized || m.agentId.toLowerCase().includes(normalized) || m.displayName.toLowerCase().includes(normalized))
      .filter(() => !req.badges?.length)
      .map((m) => ({ ...m, hierarchyBasis: basis }));
    // No source collection holds the hierarchy; the DEV fallback appends the stub roster after the real self entry.
    // Stub members carry no badges, so a badge filter still returns nothing extra.
    if (this.devMockFallback && !req.badges?.length) {
      const bases: DrilldownBasis[] = req.basis ? [req.basis] : ['AGENT', 'AM', 'UM'];
      for (const b of bases) items.push(...mockTeamMembers(b, req.query).items.filter((m) => m.agentId !== agent.agentId));
    }
    return {
      asOfDate: '2026-07-27',
      ...(req.basis ? { basis: req.basis } : {}),
      items,
      summary: ['MANPOWER', 'ACTIVITY_RATIO', 'PRODUCTIVITY', 'AVERAGE_CASE_SIZE'].map((metricCode) => ({ metricCode })),
    };
  }

  async findTeamMember(): Promise<undefined> { return undefined; }

  async getTeamMemberDashboard(agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<TeamMemberDashboard | undefined> {
    if (memberAgentId !== agent.agentId) return this.devMockFallback ? mockTeamMemberDashboard(memberAgentId, lens) : undefined;
    const list = await this.metricList(agent, { ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
    return {
      member: {
        agentId: agent.agentId,
        displayName: agent.name,
        hierarchyBasis: 'AGENT',
        roleCode: agent.level === 'P4' ? 'AGENT' : agent.level === 'P3' ? 'AM' : 'UM',
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