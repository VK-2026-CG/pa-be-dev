import { teamAgentRecord } from './team-tree.js';
/** The mock tree's AM root (L3001's reports) stands in for the caller's team. */
const MOCK_ROOT = 'L3001';
export function teamDrilldownMockEnabled(env = process.env) {
    const on = env.INSIGHTS_TEAM_DRILLDOWN_MOCK === 'true';
    if (on && env.NODE_ENV === 'production')
        throw new Error('INSIGHTS_TEAM_DRILLDOWN_MOCK is development-only');
    return on;
}
export class TeamDrilldownMockOverlay {
    real;
    mock;
    kind;
    ownIdentityOnly;
    constructor(real, mock) {
        this.real = real;
        this.mock = mock;
        this.kind = real.kind;
        this.ownIdentityOnly = real.ownIdentityOnly;
    }
    /** Logins resolve against the real allowlist only. */
    findIdentityAgent(id) {
        return this.real.resolveIdentity ? undefined : this.real.findAgent?.(id);
    }
    /** Domain reads may also target mock team members (viewing mode). */
    findAgent(id) {
        return this.real.findAgent?.(id) ?? teamAgentRecord(id);
    }
    async resolveIdentity(id) {
        if (this.real.resolveIdentity)
            return this.real.resolveIdentity(id);
        return this.real.findAgent?.(id);
    }
    isMock(agent) {
        return !this.real.findAgent?.(agent.agentId) && teamAgentRecord(agent.agentId) !== undefined;
    }
    pick(agent) {
        return this.isMock(agent) ? this.mock : this.real;
    }
    asRoot(agent) {
        return this.isMock(agent) ? agent : { ...agent, agentId: MOCK_ROOT, level: 'P2' };
    }
    metricList(agent, l, listScope, codes) {
        return this.pick(agent).metricList(agent, l, listScope, codes);
    }
    metricDetail(agent, code, l) { return this.pick(agent).metricDetail(agent, code, l); }
    metricSeries(agent, code, l, anchorYear, yearsBack) {
        return this.pick(agent).metricSeries(agent, code, l, anchorYear, yearsBack);
    }
    milestones(agent) { return this.pick(agent).milestones(agent); }
    getPreferences(agent, scope, basis) { return this.pick(agent).getPreferences(agent, scope, basis); }
    putPreferences(agent, scope, basis, body) {
        return this.pick(agent).putPreferences(agent, scope, basis, body);
    }
    recommendations(agent, scope) { return this.pick(agent).recommendations(agent, scope); }
    recordFeedback(agent, recommendationId, rating) {
        return this.pick(agent).recordFeedback(agent, recommendationId, rating);
    }
    listTeamMembers(agent, req) { return this.mock.listTeamMembers(this.asRoot(agent), req); }
    findTeamMember(agent, memberAgentId, lens) {
        return this.mock.findTeamMember(this.asRoot(agent), memberAgentId, lens);
    }
    getTeamMemberDashboard(agent, memberAgentId, lens) {
        return this.mock.getTeamMemberDashboard(this.asRoot(agent), memberAgentId, lens);
    }
}
