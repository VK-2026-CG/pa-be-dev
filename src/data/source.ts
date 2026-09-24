/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { performanceProfile } from './performance-profile.js';
import { AGENTS, type AgentRecord } from './registry.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, contextFor, metricDetail, metricList, metricSeries, milestones, type Lens } from './values.js';
import { getPreferences, putPreferences, type PrefError } from './preferences.js';
import { recommendations, recordFeedback, type RecommendationListPayload } from './recommendations.js';
import type {
  Basis,
  DrilldownBasis,
  MetricDetail,
  MetricPreferences,
  MetricSeries,
  MetricSnapshotList,
  MilestoneProgressList,
  Scope,
  TeamMemberDashboard,
  TeamMemberList,
  TeamView,
} from '../types.js';

export interface DataSource {
  readonly kind: 'memory' | 'performance';
  readonly ownIdentityOnly?: boolean;
  findAgent?(id: string): AgentRecord | undefined;
  metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]): Promise<MetricSnapshotList | undefined>;
  metricDetail(agent: AgentRecord, code: string, l: Lens): Promise<MetricDetail | undefined>;
  metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number): Promise<MetricSeries | undefined>;
  milestones(agent: AgentRecord): Promise<MilestoneProgressList>;
  getPreferences(agent: AgentRecord, scope: Scope, basis: Basis): Promise<MetricPreferences>;
  putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }):
    Promise<{ ok: true; prefs: MetricPreferences } | { ok: false; error: PrefError }>;
  recommendations(agent: AgentRecord, scope: Scope): Promise<RecommendationListPayload>;
  recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN'): Promise<boolean>;
  listTeamMembers(agent: AgentRecord, teamView: TeamView, basis: DrilldownBasis, query?: string): Promise<TeamMemberList>;
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
  async listTeamMembers(_agent: AgentRecord, _teamView: TeamView, basis: DrilldownBasis, query?: string): Promise<TeamMemberList> {
    const membersByBasis: Record<DrilldownBasis, Array<{ agentId: string; displayName: string; roleCode: string }>> = {
      AGENT: [
        { agentId: 'A1001', displayName: 'Aisyah Rahman', roleCode: 'AGENT' },
        { agentId: 'A1002', displayName: 'Demo Empty', roleCode: 'AGENT' },
        { agentId: 'A1003', displayName: 'Demo Processing', roleCode: 'AGENT' },
      ],
      AM: [
        { agentId: 'L2001', displayName: 'Farid Ismail', roleCode: 'AM' },
      ],
      UM: [
        { agentId: 'L3001', displayName: 'Mei Lin Tan', roleCode: 'UM' },
      ],
    };
    const normalizedQuery = query?.trim().toLowerCase() ?? '';
    const filtered = membersByBasis[basis]
      .filter((m) => {
        if (!normalizedQuery) return true;
        return m.agentId.toLowerCase().includes(normalizedQuery) || m.displayName.toLowerCase().includes(normalizedQuery);
      })
      .map((m) => ({ ...m, hierarchyBasis: basis }));
    return { asOfDate: '2026-07-27', items: filtered };
  }

  async getTeamMemberDashboard(_agent: AgentRecord, memberAgentId: string, lens: Lens): Promise<TeamMemberDashboard | undefined> {
    const member = AGENTS.find((a) => a.agentId === memberAgentId);
    if (!member) return undefined;
    const list = await this.metricList(member, { ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
    const selected = list.items
      .filter((item) => item.metricCode === 'TPC' || item.metricCode === 'PTPC')
      .slice(0, 2);
    return {
      member: {
        agentId: member.agentId,
        displayName: member.name,
        hierarchyBasis: 'AGENT',
        roleCode: member.level === 'P4' ? 'AGENT' : member.level === 'P3' ? 'AM' : 'UM',
      },
      context: {
        period: list.context.period,
        businessLine: list.context.businessLine,
        basis: list.context.basis,
        scope: 'SELF',
        teamView: lens.teamView,
        asOfDate: list.context.asOfDate,
      },
      metrics: selected,
    };
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
  // performanceProfile() above already refuses anything but development/test.
  const devMockFallback = process.env.INSIGHTS_DEV_MOCK_FALLBACK === 'true';
  if (devMockFallback) log('data source: DEV MOCK fallback ON — metric-detail gaps are filled with stub values');
  return new PerformanceSource(db, agents, log, devMockFallback);
}

export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };