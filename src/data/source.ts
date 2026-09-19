/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { performanceProfile } from './performance-profile.js';
import { AGENTS, type AgentRecord } from './registry.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, contextFor, metricDetail, metricList, metricSeries, milestones, type Lens } from './values.js';
import { getPreferences, putPreferences, type PrefError } from './preferences.js';
import { recommendations, recordFeedback, type RecommendationListPayload } from './recommendations.js';
import type { Basis, MetricDetail, MetricPreferences, MetricSeries, MetricSnapshotList, MilestoneProgressList, Scope } from '../types.js';

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
  return new PerformanceSource(db, agents, log);
}

export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };