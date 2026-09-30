import { findAgent } from '../data/registry.js';
import { CATALOG } from '../data/catalog.js';
import { ANCHOR_YEAR } from '../data/values.js';
export class DomainError extends Error {
    status;
    code;
    title;
    constructor(status, code, title) {
        super(`${status} ${code} ${title}`);
        this.status = status;
        this.code = code;
        this.title = title;
    }
}
function agentForSource(source, agentId) {
    const agent = source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
    if (!agent)
        throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
    return agent;
}
function lensOf(p) {
    return {
        period: (p.period ?? 'YTD'),
        businessLine: (p.businessLine ?? 'ALL'),
        basis: (p.basis ?? 'STANDARD'),
        scope: (p.scope ?? 'SELF'),
        ...(p.teamView ? { teamView: p.teamView } : {}),
    };
}
function teamDashboardLensOf(p) {
    return {
        period: (p.period ?? 'YTD'),
        businessLine: (p.businessLine ?? 'ALL'),
        basis: (p.performanceBasis ?? 'STANDARD'),
        scope: 'TEAM',
        teamView: (p.teamView ?? 'DIRECT'),
    };
}
export function createInsightsDomain(source) {
    const agentOrThrow = (id) => agentForSource(source, id);
    return {
        // These payloads cross into the BFF composition layer (`src/bff/compose/*`), which — like the
        // former HTTP domain-client — treats them loosely (`any`) rather than binding to the domain's
        // strict internal types (e.g. `MetricDefinition`'s `capabilities` vs. the composers' `Record<string,boolean>`).
        metrics: async (_caller, agentId, p) => {
            const agent = agentOrThrow(agentId);
            const listScope = (p.listScope ?? 'ALL');
            const codes = p.codes ? p.codes.split(',') : undefined;
            const list = await source.metricList(agent, lensOf(p), listScope, codes);
            if (!list)
                throw new DomainError(404, 'INS-4040', 'No data materialized for this lens');
            return list;
        },
        metricDetail: async (_caller, agentId, code, p) => {
            const agent = agentOrThrow(agentId);
            const detail = await source.metricDetail(agent, code, lensOf(p));
            if (!detail)
                throw new DomainError(404, 'INS-4041', 'Metric not in catalog for this lens');
            return detail;
        },
        series: async (_caller, agentId, code, p) => {
            const agent = agentOrThrow(agentId);
            const anchorYear = p.anchorYear ?? ANCHOR_YEAR;
            const yearsBack = p.yearsBack ?? 2;
            const s = await source.metricSeries(agent, code, lensOf(p), anchorYear, yearsBack);
            if (!s)
                throw new DomainError(404, 'INS-4041', 'Metric has no history for this lens');
            return s;
        },
        milestones: async (_caller, agentId) => {
            const agent = agentOrThrow(agentId);
            return source.milestones(agent);
        },
        definitions: async (agentId) => {
            const agent = agentOrThrow(agentId);
            return { country: agent.tenant, items: CATALOG };
        },
        preferences: async (_caller, agentId, scope) => {
            const agent = agentOrThrow(agentId);
            return source.getPreferences(agent, scope, 'STANDARD');
        },
        putPreferences: async (_caller, agentId, scope, body) => {
            const agent = agentOrThrow(agentId);
            const res = await source.putPreferences(agent, scope, 'STANDARD', body);
            if (!res.ok)
                throw new DomainError(422, res.error.code, 'Preference validation failed');
            return res.prefs;
        },
        recommendations: async (_caller, agentId, scope) => {
            const agent = agentOrThrow(agentId);
            return source.recommendations(agent, scope);
        },
        feedback: async (_caller, agentId, recommendationId, rating) => {
            const agent = agentOrThrow(agentId);
            const ok = await source.recordFeedback(agent, recommendationId, rating);
            if (!ok)
                throw new DomainError(404, 'INS-4042', 'Unknown recommendation');
        },
        listTeamMembers: async (_caller, agentId, p) => {
            const agent = agentOrThrow(agentId);
            return source.listTeamMembers(agent, (p.teamView ?? 'DIRECT'), (p.basis ?? 'AGENT'), p.query);
        },
        getTeamMemberDashboard: async (_caller, agentId, memberAgentId, p) => {
            const agent = agentOrThrow(agentId);
            const detail = await source.getTeamMemberDashboard(agent, memberAgentId, teamDashboardLensOf(p));
            if (!detail)
                throw new DomainError(404, 'INS-4040', 'Unknown team member for leader');
            return detail;
        },
    };
}
