/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb, getPreferencesDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { AGENTS, findAgent as findRegisteredAgent, type AgentRecord } from './registry.js';
import { listTeam, teamAgentRecord, visibleMember } from './team-tree.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, AS_OF_DATE, contextFor, metricDetail, metricList, metricSeries, milestones, type Lens } from './values.js';
import { getPreferences, memoryPreferences, MongoPreferenceStore, PREFERENCES_COLLECTION, putPreferences, type PrefError } from './preferences.js';
import { recommendations, recordFeedback, type RecommendationListPayload } from './recommendations.js';
import { mockTeamMemberDashboard } from './mocks/team-members.js';
import { stubMonthlyHistory } from './mocks/monthly-history.js';
import type {
  Basis,
  DrilldownBasis,
  MemberBadgeCode,
  MetricDetail,
  MetricPreferences,
  MetricSeries,
  MetricSnapshotList,
  MilestoneProgressList,
  MonthlyHistory,
  MonthlyHistoryRequest,
  Scope,
  TeamMember,
  TeamMemberDashboard,
  TeamMemberList,
  TeamMemberSortBy,
  TeamView,
  AgentOrganization,
} from '../types.js';

/** `listTeamMembers` request (insights.v1.yaml 1.6.0). */
export interface TeamListRequest {
  teamView: TeamView;
  /** Absent ⇒ every hierarchy level (1.6.0). */
  basis?: DrilldownBasis;
  query?: string;
  sortBy: TeamMemberSortBy;
  /** ANY-match; absent/empty ⇒ all members (D-P4-07-02). */
  badges?: MemberBadgeCode[];
  /** Subteam drawer: list this downline member's direct reports instead. */
  parentMemberAgentId?: string;
  /** Period/business line/performance basis for member TPC/PTPC and KPI values. */
  lens: Lens;
}

export interface DataSource {
  readonly kind: 'memory' | 'performance';
  readonly ownIdentityOnly?: boolean;
  findAgent?(id: string): AgentRecord | undefined;
  /** Domain-owned identity lookup; Mongo-backed implementations resolve roles from hierarchy. */
  resolveIdentity?(id: string): Promise<AgentRecord | undefined>;
  metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]): Promise<MetricSnapshotList | undefined>;
  metricDetail(agent: AgentRecord, code: string, l: Lens): Promise<MetricDetail | undefined>;
  metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined>;
  milestones(agent: AgentRecord): Promise<MilestoneProgressList>;
  getPreferences(agent: AgentRecord, scope: Scope, basis: Basis): Promise<MetricPreferences>;
  putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }):
    Promise<{ ok: true; prefs: MetricPreferences } | { ok: false; error: PrefError }>;
  recommendations(agent: AgentRecord, scope: Scope): Promise<RecommendationListPayload>;
  recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN'): Promise<boolean>;
  /** Undefined when `parentMemberAgentId` is not visible to the caller (D-14: P3 DIRECT team, P2 whole downline). */
  listTeamMembers(agent: AgentRecord, req: TeamListRequest): Promise<TeamMemberList | undefined>;
  /** A member visible to the leader (same D-14 rule) plus the record to compose their dashboard; undefined otherwise. */
  findTeamMember(agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<{ member: TeamMember; record: AgentRecord } | undefined>;
  getTeamMemberDashboard(
    agent: AgentRecord,
    memberAgentId: string,
    lens: Lens,
  ): Promise<TeamMemberDashboard | undefined>;
  getAgentOrganization?(agentId: string): Promise<AgentOrganization | undefined>;
  /**
   * ARVIJ-1450: month-level values for `from`..`to` (inclusive `YYYY-MM`, already validated, <= 48 months), one record per
   * (period, source database, aggregation) that has a row; months without rows are absent. No aggregation fallback.
   * Mongo failures throw an error carrying a sanitized `sourceCause`.
   */
  monthlyHistory(agent: AgentRecord, req: MonthlyHistoryRequest): Promise<MonthlyHistory>;
}

/** Offline regression fixture engine only; never a Mongo read fallback. */
class MemorySource implements DataSource {
  readonly kind = 'memory' as const;
  async metricList(_agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) { return metricList(l, listScope, codes); }
  async metricDetail(agent: AgentRecord, code: string, l: Lens) { return metricDetail(code, l, agent.demoDataState); }
  async metricSeries(_agent: AgentRecord, code: string, l: Lens, year: number, back: number) { return metricSeries(code, l, year, back); }
  async milestones() { return milestones(); }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return getPreferences(memoryPreferences, agent.tenant, agent.agentId, scope, basis); }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(memoryPreferences, agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord, scope: Scope) { return recommendations(agent.agentId, scope); }
  async recordFeedback(agent: AgentRecord, id: string, rating: 'UP' | 'DOWN') { return recordFeedback(agent.agentId, id, rating); }
  /** Registry personas plus the deterministic team hierarchy (so a leader can view a member's dashboard). */
  findAgent(id: string): AgentRecord | undefined {
    return findRegisteredAgent(id) ?? teamAgentRecord(id);
  }
  async resolveIdentity(id: string): Promise<AgentRecord | undefined> { return this.findAgent(id); }

  async listTeamMembers(agent: AgentRecord, req: TeamListRequest): Promise<TeamMemberList | undefined> {
    const parent = req.parentMemberAgentId ? visibleMember(agent, req.parentMemberAgentId, req.lens) : undefined;
    if (req.parentMemberAgentId && !parent) return undefined;
    const { items, summary } = listTeam(parent?.agentId ?? agent.agentId, req);
    return {
      asOfDate: AS_OF_DATE,
      ...(req.basis ? { basis: req.basis } : {}),
      items,
      ...(parent ? { parent } : { summary }),
    };
  }

  async findTeamMember(agent: AgentRecord, memberAgentId: string, lens: Lens) {
    const member = visibleMember(agent, memberAgentId, lens);
    const record = member ? this.findAgent(memberAgentId) : undefined;
    return member && record ? { member, record } : undefined;
  }

  async getTeamMemberDashboard(_agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<TeamMemberDashboard | undefined> {
    return mockTeamMemberDashboard(memberAgentId, lens);
  }
  async getAgentOrganization(): Promise<undefined> { return undefined; }
  async monthlyHistory(agent: AgentRecord, req: MonthlyHistoryRequest): Promise<MonthlyHistory> { return stubMonthlyHistory(agent, req); }
}

export async function createSource(log: (msg: string) => void = () => {}): Promise<DataSource> {
  if (process.env.INSIGHTS_DATA_SOURCE && !['memory', 'performance'].includes(process.env.INSIGHTS_DATA_SOURCE)) {
    throw new Error('Unsupported Performance data source; legacy Mongo adapter has been removed');
  }
  const configuredMongo = process.env.MONGODB_PERFORMANCE_URI !== undefined || Boolean(process.env.MONGODB_URI);
  if (process.env.INSIGHTS_DATA_SOURCE === 'memory') {
    if (process.env.NODE_ENV !== 'test') throw new Error('In-memory data source is test-only');
    log('data source: offline in-memory regression fixtures (no database reads)');
    return new MemorySource();
  }
  if (!configuredMongo) throw new Error('Performance database connection required');
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new Error('Performance source mode requires development/test');
  const [pamb, pbtb] = await Promise.all([getPerformanceDb('PAMB'), getPerformanceDb('PBTB')]);
  const dbs = { PAMB: pamb, PBTB: pbtb };
  const preferencesDb = await getPreferencesDb();
  const preferences = new MongoPreferenceStore(preferencesDb.collection(PREFERENCES_COLLECTION));
  log(`preferences: ${preferencesDb.databaseName}.${PREFERENCES_COLLECTION}`);
  log('data source: direct Performance Mongo DEVELOPMENT profile (three metric collections + read-only my_agent_hierarchy)');
  if (process.env.INSIGHTS_DEV_MOCK_FALLBACK === 'true' || process.env.INSIGHTS_TEAM_DRILLDOWN_MOCK === 'true' || process.env.INSIGHTS_HIERARCHY_SOURCE !== undefined) {
    log('data source: ignoring deprecated mock/hierarchy flags; runtime mock fallbacks are disabled and hierarchy is always read');
  }
  return new PerformanceSource(dbs, new Map(), log, false, false, preferences);
}

export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };