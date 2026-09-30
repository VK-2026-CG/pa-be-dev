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
async function agentForSource(source, agentId) {
    try {
        const agent = source.resolveIdentity ? await source.resolveIdentity(agentId) : source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
        if (!agent)
            throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
        return agent;
    }
    catch (error) {
        if (error instanceof DomainError)
            throw error;
        if (error instanceof Error && error.message === 'Identity hierarchy source read failed')
            throw new DomainError(503, 'INS-5030', 'Identity source unavailable');
        if (error instanceof Error && error.message === 'Malformed identity hierarchy')
            throw new DomainError(500, 'INS-5000', 'Identity data is invalid');
        throw error;
    }
}
async function identityForSource(source, agentId) {
    try {
        return source.resolveIdentity ? await source.resolveIdentity(agentId) : source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Identity hierarchy source read failed')
            throw new DomainError(503, 'INS-5030', 'Identity source unavailable');
        if (error instanceof Error && error.message === 'Malformed identity hierarchy')
            throw new DomainError(500, 'INS-5000', 'Identity data is invalid');
        throw error;
    }
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
        ownIdentityOnly: source.ownIdentityOnly ?? false,
        resolveIdentity: async (id) => identityForSource(source, id),
        // These payloads cross into the BFF composition layer (`src/bff/compose/*`), which — like the
        // former HTTP domain-client — treats them loosely (`any`) rather than binding to the domain's
        // strict internal types (e.g. `MetricDefinition`'s `capabilities` vs. the composers' `Record<string,boolean>`).
        metrics: async (_caller, agentId, p) => {
            const agent = await agentOrThrow(agentId);
            const listScope = (p.listScope ?? 'ALL');
            const codes = p.codes ? p.codes.split(',') : undefined;
            const list = await source.metricList(agent, lensOf(p), listScope, codes);
            if (!list)
                throw new DomainError(404, 'INS-4040', 'No data materialized for this lens');
            return list;
        },
        metricDetail: async (_caller, agentId, code, p) => {
            const agent = await agentOrThrow(agentId);
            const detail = await source.metricDetail(agent, code, lensOf(p));
            if (!detail)
                throw new DomainError(404, 'INS-4041', 'Metric not in catalog for this lens');
            return detail;
        },
        series: async (_caller, agentId, code, p) => {
            const agent = await agentOrThrow(agentId);
            const anchorYear = p.anchorYear ?? ANCHOR_YEAR;
            const yearsBack = p.yearsBack ?? 2;
            const s = await source.metricSeries(agent, code, lensOf(p), anchorYear, yearsBack);
            if (!s)
                throw new DomainError(404, 'INS-4041', 'Metric has no history for this lens');
            return s;
        },
        milestones: async (_caller, agentId) => {
            const agent = await agentOrThrow(agentId);
            return source.milestones(agent);
        },
        definitions: async (agentId) => {
            const agent = await agentOrThrow(agentId);
            return { country: agent.tenant, items: CATALOG };
        },
        preferences: async (_caller, agentId, scope) => {
            const agent = await agentOrThrow(agentId);
            return source.getPreferences(agent, scope, 'STANDARD');
        },
        putPreferences: async (_caller, agentId, scope, body) => {
            const agent = await agentOrThrow(agentId);
            const res = await source.putPreferences(agent, scope, 'STANDARD', body);
            if (!res.ok)
                throw new DomainError(422, res.error.code, 'Preference validation failed');
            return res.prefs;
        },
        recommendations: async (_caller, agentId, scope) => {
            const agent = await agentOrThrow(agentId);
            return source.recommendations(agent, scope);
        },
        feedback: async (_caller, agentId, recommendationId, rating) => {
            const agent = await agentOrThrow(agentId);
            const ok = await source.recordFeedback(agent, recommendationId, rating);
            if (!ok)
                throw new DomainError(404, 'INS-4042', 'Unknown recommendation');
        },
        listTeamMembers: async (_caller, agentId, p) => {
            const agent = await agentOrThrow(agentId);
            const list = await source.listTeamMembers(agent, {
                teamView: (p.teamView ?? 'DIRECT'),
                ...(p.basis ? { basis: p.basis } : {}),
                ...(p.query ? { query: p.query } : {}),
                sortBy: p.sortBy ?? 'TPC',
                ...(p.badges?.length ? { badges: p.badges } : {}),
                ...(p.parentMemberAgentId ? { parentMemberAgentId: p.parentMemberAgentId } : {}),
                lens: { ...teamDashboardLensOf(p), scope: 'SELF' },
            });
            if (!list)
                throw new DomainError(403, 'INS-4030', 'Member is not in the caller\'s downline');
            return list;
        },
        /** Downline membership check (D-14) + the record used to compose a viewed member's dashboard. */
        findTeamMember: async (_caller, agentId, memberAgentId) => {
            const agent = await agentOrThrow(agentId);
            const found = await source.findTeamMember(agent, memberAgentId, { period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
            if (!found)
                throw new DomainError(403, 'INS-4030', 'Member is not in the caller\'s downline');
            return { member: found.member, agentId: found.record.agentId, level: found.record.level };
        },
        getTeamMemberDashboard: async (_caller, agentId, memberAgentId, p) => {
            const agent = await agentOrThrow(agentId);
            const detail = await source.getTeamMemberDashboard(agent, memberAgentId, teamDashboardLensOf(p));
            if (!detail)
                throw new DomainError(404, 'INS-4040', 'Unknown team member for leader');
            return detail;
        },
        getAgentOrganization: async (_caller, agentId) => {
            if (!source.getAgentOrganization)
                throw new DomainError(503, 'INS-5030', 'Organization source unavailable');
            let organization;
            try {
                organization = await source.getAgentOrganization(agentId);
            }
            catch (error) {
                if (error instanceof Error && ['Hierarchy cycle', 'Malformed hierarchy'].includes(error.message)) {
                    throw new DomainError(500, 'INS-5000', 'Organization data is invalid');
                }
                throw new DomainError(503, 'INS-5030', 'Organization source unavailable');
            }
            if (!organization)
                throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
            return organization;
        },
    };
}
