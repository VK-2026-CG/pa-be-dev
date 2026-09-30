/** Performance data boundary: three source collections in Mongo, or isolated offline tests. */
import { getPerformanceDb } from '../db/mongo.js';
import { PerformanceSource } from './performance-source.js';
import { AGENTS, findAgent as findRegisteredAgent } from './registry.js';
import { listTeam, teamAgentRecord, visibleMember } from './team-tree.js';
import { CATALOG } from './catalog.js';
import { ANCHOR_YEAR, AS_OF_DATE, contextFor, metricDetail, metricList, metricSeries, milestones } from './values.js';
import { getPreferences, putPreferences } from './preferences.js';
import { recommendations, recordFeedback } from './recommendations.js';
import { mockTeamMemberDashboard } from './mocks/team-members.js';
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
    /** Registry personas plus the deterministic team hierarchy (so a leader can view a member's dashboard). */
    findAgent(id) {
        return findRegisteredAgent(id) ?? teamAgentRecord(id);
    }
    async resolveIdentity(id) { return this.findAgent(id); }
    async listTeamMembers(agent, req) {
        const parent = req.parentMemberAgentId ? visibleMember(agent, req.parentMemberAgentId, req.lens) : undefined;
        if (req.parentMemberAgentId && !parent)
            return undefined;
        const { items, summary } = listTeam(parent?.agentId ?? agent.agentId, req);
        return {
            asOfDate: AS_OF_DATE,
            ...(req.basis ? { basis: req.basis } : {}),
            items,
            ...(parent ? { parent } : { summary }),
        };
    }
    async findTeamMember(agent, memberAgentId, lens) {
        const member = visibleMember(agent, memberAgentId, lens);
        const record = member ? this.findAgent(memberAgentId) : undefined;
        return member && record ? { member, record } : undefined;
    }
    async getTeamMemberDashboard(_agent, memberAgentId, lens) {
        return mockTeamMemberDashboard(memberAgentId, lens);
    }
    async getAgentOrganization() { return undefined; }
}
export async function createSource(log = () => { }) {
    if (process.env.INSIGHTS_DATA_SOURCE && !['memory', 'performance'].includes(process.env.INSIGHTS_DATA_SOURCE)) {
        throw new Error('Unsupported Performance data source; legacy Mongo adapter has been removed');
    }
    const configuredMongo = process.env.MONGODB_PERFORMANCE_URI !== undefined || Boolean(process.env.MONGODB_URI);
    if (process.env.INSIGHTS_DATA_SOURCE === 'memory') {
        if (process.env.NODE_ENV !== 'test')
            throw new Error('In-memory data source is test-only');
        log('data source: offline in-memory regression fixtures (no database reads)');
        return new MemorySource();
    }
    if (!configuredMongo)
        throw new Error('Performance database connection required');
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
        throw new Error('Performance source mode requires development/test');
    const [pamb, pbtb] = await Promise.all([getPerformanceDb('PAMB'), getPerformanceDb('PBTB')]);
    const dbs = { PAMB: pamb, PBTB: pbtb };
    log('data source: direct Performance Mongo DEVELOPMENT profile (three metric collections + read-only my_agent_hierarchy)');
    if (process.env.INSIGHTS_DEV_MOCK_FALLBACK === 'true' || process.env.INSIGHTS_TEAM_DRILLDOWN_MOCK === 'true' || process.env.INSIGHTS_HIERARCHY_SOURCE !== undefined) {
        log('data source: ignoring deprecated mock/hierarchy flags; runtime mock fallbacks are disabled and hierarchy is always read');
    }
    return new PerformanceSource(dbs, new Map(), log);
}
export { AGENTS, ANCHOR_YEAR, CATALOG, contextFor };
