/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { performanceProfile } from './performance-profile.js';
import { AGENTS } from './registry.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, contextFor, metricDetail, metricList, metricSeries, milestones } from './values.js';
import { getPreferences, putPreferences } from './preferences.js';
import { recommendations, recordFeedback } from './recommendations.js';
import { mockTeamMemberDashboard, mockTeamMembers } from './mocks/team-members.js';
/** Offline regression fixture engine only; never a Mongo read fallback. */
class MemorySource {
    kind = 'memory';
    async metricList(_agent, l, listScope, codes) { return metricList(l, listScope, codes); }
    async metricDetail(agent, code, l) { return metricDetail(code, l, agent.demoDataState); }
    async metricSeries(_agent, code, l, year, back) { return metricSeries(code, l, year, back); }
    async milestones() { return milestones(); }
    async getPreferences(agent, scope, basis) { return getPreferences(agent.tenant, agent.agentId, scope, basis); }
    async putPreferences(agent, scope, basis, body) {
        return putPreferences(agent.tenant, agent.agentId, scope, basis, body);
    }
    async recommendations(agent, scope) { return recommendations(agent.agentId, scope); }
    async recordFeedback(agent, id, rating) { return recordFeedback(agent.agentId, id, rating); }
    async listTeamMembers(_agent, _teamView, basis, query) {
        return mockTeamMembers(basis, query);
    }
    async getTeamMemberDashboard(_agent, memberAgentId, lens) {
        return mockTeamMemberDashboard(memberAgentId, lens);
    }
}
export async function createSource(log = () => { }) {
    if (process.env.INSIGHTS_DATA_SOURCE && !['memory', 'performance'].includes(process.env.INSIGHTS_DATA_SOURCE)) {
        throw new Error('Unsupported Performance data source; legacy Mongo adapter has been removed');
    }
    const configuredMongo = process.env.MONGODB_PERFORMANCE_URI !== undefined || Boolean(process.env.MONGODB_URI);
    if (process.env.INSIGHTS_DATA_SOURCE === 'memory' || !configuredMongo) {
        if (process.env.NODE_ENV === 'production' || process.env.INSIGHTS_DATA_SOURCE === 'performance')
            throw new Error('Performance database connection required');
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
    if (devMockFallback)
        log('data source: DEV MOCK fallback ON — anything Mongo cannot supply is filled with stub values');
    else if (requested)
        log('data source: INSIGHTS_DEV_MOCK_FALLBACK ignored — requires NODE_ENV=development');
    return new PerformanceSource(db, agents, log, devMockFallback);
}
export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };
