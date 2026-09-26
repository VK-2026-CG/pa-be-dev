/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { performanceProfile } from './performance-profile.js';
import { AGENTS, findAgent as findRegisteredAgent, type AgentRecord } from './registry.js';
import { listTeam, teamAgentRecord, visibleMember } from './team-tree.js';
import { TeamDrilldownMockOverlay, teamDrilldownMockEnabled } from './team-mock-overlay.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, AS_OF_DATE, contextFor, metricDetail, metricList, metricSeries, milestones, type Lens } from './values.js';
import { getPreferences, putPreferences, type PrefError } from './preferences.js';
import { recommendations, recordFeedback, type RecommendationListPayload } from './recommendations.js';
import { mockTeamMemberDashboard } from './mocks/team-members.js';
import type {
  Basis,
  DrilldownBasis,
  MemberBadgeCode,
  MetricDetail,
  MetricPreferences,
  MetricSeries,
  MetricSnapshotList,
  MilestoneProgressList,
  Scope,
  TeamMember,
  TeamMemberDashboard,
  TeamMemberList,
  TeamMemberSortBy,
  TeamView,
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
  /** Login identities only; defaults to `findAgent` (differs under the Team Drilldown mock overlay). */
  findIdentityAgent?(id: string): AgentRecord | undefined;
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
}

/** Offline regression fixture engine only; never a Mongo read fallback. */
class MemorySource implements DataSource {
  readonly kind = 'memory' as const;
  async metricList(_agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) { return metricList(l, listScope, codes); }
  async metricDetail(agent: AgentRecord, code: string, l: Lens) { return metricDetail(code, l, agent.demoDataState); }
  async metricSeries(_agent: AgentRecord, code: string, l: Lens, year: number, back: number) { return metricSeries(code, l, year, back); }
  async milestones() { return milestones(); }
  async getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
  async putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
  }
  async recommendations(agent: AgentRecord, scope: Scope) { return recommendations(agent.agentId, scope); }
  async recordFeedback(agent: AgentRecord, id: string, rating: 'UP' | 'DOWN') { return recordFeedback(agent.agentId, id, rating); }
  /** Registry personas plus the deterministic team hierarchy (so a leader can view a member's dashboard). */
  findAgent(id: string): AgentRecord | undefined {
    return findRegisteredAgent(id) ?? teamAgentRecord(id);
  }

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
}

export async function createSource(log: (msg: string) => void = () => {}): Promise<DataSource> {
  if (process.env.INSIGHTS_DATA_SOURCE && !['memory', 'performance'].includes(process.env.INSIGHTS_DATA_SOURCE)) {
    throw new Error('Unsupported Performance data source; legacy Mongo adapter has been removed');
  }
  const configuredMongo = process.env.MONGODB_PERFORMANCE_URI !== undefined || Boolean(process.env.MONGODB_URI);
  if (process.env.INSIGHTS_DATA_SOURCE === 'memory' || !configuredMongo) {
    if (process.env.NODE_ENV === 'production' || process.env.INSIGHTS_DATA_SOURCE === 'performance') throw new Error('Performance database connection required');
    log('data source: offline in-memory regression fixtures (no database reads)');
    return new MemorySource();
  }
  const agents = performanceProfile();
  const db = await getPerformanceDb();
  log('data source: direct Performance Mongo DEVELOPMENT profile (three collections only)');
  // performanceProfile() above already refuses anything but development/test; the
  // fallback is narrower still: NODE_ENV=development only, never test/shared.
  const requested = process.env.INSIGHTS_DEV_MOCK_FALLBACK === 'true';
  const devMockFallback = requested && process.env.NODE_ENV === 'development';
  if (devMockFallback) log('data source: DEV MOCK fallback ON — anything Mongo cannot supply is filled with stub values');
  else if (requested) log('data source: INSIGHTS_DEV_MOCK_FALLBACK ignored — requires NODE_ENV=development');
  const source = new PerformanceSource(db, agents, log, devMockFallback);
  if (teamDrilldownMockEnabled()) {
    log('⚠ INSIGHTS_TEAM_DRILLDOWN_MOCK=true: Team Drilldown hierarchy/badges/goals are MOCK data (development only, SPEC-2026-004 D-P4-07-06)');
    return new TeamDrilldownMockOverlay(source, new MemorySource());
  }
  return source;
}

export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };