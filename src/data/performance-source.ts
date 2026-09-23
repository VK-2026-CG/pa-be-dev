import type { Db, Document } from 'mongodb';
import type { DataSource } from './source.js';
import type { AgentRecord } from './registry.js';
import { effectiveCatalog, type EffectiveDef } from './catalog.js';
import { getPreferences, putPreferences } from './preferences.js';
import { PERFORMANCE_COLLECTIONS, PERFORMANCE_DB, PERFORMANCE_READ_TIMEOUT_MS, type PerformanceCollection } from '../config/performance.js';
import { PERFORMANCE_METRIC_MAPPING, PERFORMANCE_SOURCE_KEYS, performanceMetricPath } from './performance-mapping.js';
import { sourceMetricScalar } from './performance-values.js';
import { performanceRecordMetadata, PerformanceSourceNotFound } from './performance-record.js';
import type { Lens } from './values.js';
import type {
  Basis,
  DrilldownBasis,
  MetricDetail,
  MetricScalar,
  MetricSeries,
  MetricSnapshot,
  Scope,
  SnapshotContext,
  TeamMemberDashboard,
  TeamMemberList,
  TeamView,
} from '../types.js';
import { mockTeamPendersCaseCount } from './mocks/team-penders.js';

type Rows = Partial<Record<PerformanceCollection, Document>>;
const at = (row: Document | undefined, path: string): unknown => path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Document)[key] : undefined, row);
const periodRank = (row: Document): number => performanceRecordMetadata(row).rank;

/** Guarded development adapter; no canonical/legacy collection fallback. */
export class PerformanceSource implements DataSource {
  readonly kind = 'performance' as const;
  readonly ownIdentityOnly = true;
  constructor(
    private readonly db: Db,
    private readonly agents: Map<string, AgentRecord>,
    private readonly log: (msg: string) => void = () => {},
  ) {
    if (db.databaseName !== PERFORMANCE_DB) throw new Error('Invalid Performance source database');
  }
  findAgent = (id: string): AgentRecord | undefined => this.agents.get(id);

  private async latest(agent: AgentRecord, aggregation?: string): Promise<Rows> {
    if (agent.tenant !== 'MY' || !this.agents.has(agent.agentId)) throw new Error('Identity not allowed in Performance profile');
    const entries = await Promise.all(PERFORMANCE_COLLECTIONS.map(async name => {
      const keys = PERFORMANCE_SOURCE_KEYS[name];
      const query: Document = { [keys.identity]: agent.agentId, entity: 'PAMB' };
      if (aggregation) query[keys.aggregation] = aggregation;
      if (name === 'my_production') query.case_status = 'Collected';
      // Only fields necessary for mapping; names, identifiers and vault data never leave Mongo.
      let docs: Document[];
      try {
        docs = await this.db.collection(name).find(query, {
          projection: { _id: 0, period: 1, asOnDate: 1, ptd: 1, metrics: 1 },
          maxTimeMS: PERFORMANCE_READ_TIMEOUT_MS,
        }).sort({ 'period.year': -1, 'period.month': -1, asOnDate: -1, 'audit.updatedAt': -1, id: 1, _id: 1 }).limit(1).toArray();
      } catch {
        // Driver messages can expose hosts, query arguments or credentials.
        throw new Error('Performance source read failed');
      }
      this.log(`performance read: agent=${agent.agentId} collection=${name} aggregation=${aggregation ?? 'none'} found=${Boolean(docs[0])}`);
      if (docs[0]) performanceRecordMetadata(docs[0]);
      return [name, docs[0]] as const;
    }));
    return Object.fromEntries(entries.filter(([, row]) => row)) as Rows;
  }

  private async selection(agent: AgentRecord, lens: Lens): Promise<{ rows: Rows; context: SnapshotContext }> {
    const supported = lens.businessLine === 'INSURANCE' && lens.basis === 'STANDARD'
      && (lens.scope === 'SELF' || lens.teamView === 'GROUP');
    const available = await this.latest(agent, lens.scope === 'SELF' ? 'Personal' : 'Group');
    const contexts = Object.values(available).length ? available : await this.latest(agent);
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
    const rows: Rows = supported ? Object.fromEntries(Object.entries(available).filter(([, row]) => periodRank(row!) === rank)) : {};
    return {
      rows,
      context: { period: { type: lens.period, startDate: date(startMonth, 1), endDate: date(month, day) },
        businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope,
        ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
        asOfDate: current.map(row => performanceRecordMetadata(row).asOfDate).sort()[0]! },
    };
  }

  private value(def: EffectiveDef, rows: Rows, lens: Lens, repriced = false): MetricScalar | undefined {
    const mapping = PERFORMANCE_METRIC_MAPPING[def.metricCode];
    if (!mapping || mapping.valueType !== def.valueType) return undefined;
    const path = performanceMetricPath(mapping, lens.period, repriced);
    return path ? sourceMetricScalar(def.valueType, at(rows[mapping.collection], path), mapping.fraction) : undefined;
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
    const { rows, context } = await this.selection(agent, lens);
    const collected = this.value(def, rows, lens);
    const alt = collected && def.capabilities.repricing ? this.value(def, rows, lens, true) : undefined;
    // v1.7.0 (AC-P4-02-32): TEAM-scope Penders case count for TPC/PTPC. No collection here
    // materializes this yet (mongodb.md v1.7.0 D-19) — mock-sourced until it does, same
    // interim source as the stub engine in values.ts; never derived from a money field.
    const pendersCaseCount = collected && def.capabilities.repricing && lens.scope === 'TEAM'
      ? mockTeamPendersCaseCount(code, lens.teamView ?? 'DIRECT')
      : undefined;
    return { metricCode: code, valueType: def.valueType, context, dataState: collected ? 'OK' : 'EMPTY',
      ...(collected ? { primary: { variant: 'WITHOUT_REPRICING' as const, collected } } : {}),
      ...(alt ? { altVariants: [{ variant: 'WITH_REPRICING' as const, collected: alt }] } : {}),
      ...(collected && def.threshold ? { threshold: def.threshold } : {}),
      ...(pendersCaseCount !== undefined ? { pendersCaseCount } : {}) };
  }
  async metricSeries(agent: AgentRecord, code: string, lens: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined> {
    const def = effectiveCatalog(lens.scope, lens.basis).find(d => d.metricCode === code);
    if (!def?.capabilities.history) return undefined;
    const { context } = await this.selection(agent, lens);
    return { metricCode: code, valueType: def.valueType,
      context: { businessLine: context.businessLine, basis: context.basis, scope: context.scope,
        ...(context.teamView ? { teamView: context.teamView } : {}), asOfDate: context.asOfDate }, anchorYear,
      series: Array.from({ length: yearsBack + 1 }, (_, offset) => ({ year: anchorYear - offset,
        points: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, value: null })) })) };
  }
  async milestones(agent: AgentRecord) {
    const { context } = await this.selection(agent, { period: 'YTD', scope: 'SELF', basis: 'STANDARD', businessLine: 'INSURANCE' });
    return { asOfDate: context.asOfDate, items: [] };
  }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord) {
    const { asOfDate } = await this.milestones(agent);
    return { items: [], generatedAt: `${asOfDate}T00:00:00Z` };
  }
  async recordFeedback() { return false; }

  async listTeamMembers(agent: AgentRecord, _teamView: TeamView, basis: DrilldownBasis, query?: string): Promise<TeamMemberList> {
    const base = [
      { agentId: agent.agentId, displayName: agent.name, roleCode: basis },
    ];
    const normalized = query?.trim().toLowerCase() ?? '';
    const items = base
      .filter((m) => !normalized || m.agentId.toLowerCase().includes(normalized) || m.displayName.toLowerCase().includes(normalized))
      .map((m) => ({ ...m, hierarchyBasis: basis }));
    return { asOfDate: '2026-07-27', items };
  }

  async getTeamMemberDashboard(agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<TeamMemberDashboard | undefined> {
    if (memberAgentId !== agent.agentId) return undefined;
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