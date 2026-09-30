import { TEAM_DRILLDOWN_CONFIG } from '../config.js';
import { buildMeta } from './shared.js';
function memberVM(m) {
    return {
        ...m,
        nav: { route: 'insights/performance', params: { subjectAgentId: m.agentId } },
    };
}
export async function composeTeamDrilldown(api, persona, input) {
    const list = await api.listTeamMembers(persona.agentId, persona.agentId, {
        teamView: input.teamView,
        ...(input.basis ? { basis: input.basis } : {}),
        ...(input.search ? { query: input.search } : {}),
        period: input.period,
        businessLine: input.businessLine,
        performanceBasis: input.performanceBasis,
        sortBy: input.sortBy,
        badges: input.badges,
        ...(input.parentAgentId ? { parentMemberAgentId: input.parentAgentId } : {}),
    });
    const cfg = TEAM_DRILLDOWN_CONFIG;
    const summaryByCode = new Map((list.summary ?? []).map((t) => [t.metricCode, t]));
    const summary = list.parent
        ? undefined
        : cfg.summary.metrics.map((metricCode) => {
            const tile = summaryByCode.get(metricCode);
            const valueType = (tile?.value?.kind ?? (metricCode === 'MANPOWER' ? 'COUNT'
                : metricCode === 'ACTIVITY_RATIO' ? 'PERCENT'
                    : metricCode === 'PRODUCTIVITY' ? 'DECIMAL' : 'MONEY'));
            return { metricCode, valueType, ...(tile?.value ? { value: tile.value } : {}) };
        });
    return {
        // S-P4-07 carries its own screen/config versions, not the dashboard's (SPEC-2026-004).
        meta: { ...buildMeta('S-P4-07', list.asOfDate), specVersion: '0.2.0', configVersion: cfg.configVersion },
        filters: {
            scope: 'TEAM',
            teamView: input.teamView,
            ...(input.basis ? { basis: input.basis } : {}),
            ...(input.search ? { search: input.search } : {}),
            sortBy: input.sortBy,
            ...(input.badges.length ? { badges: input.badges } : {}),
            ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
        },
        members: list.items.slice(0, cfg.memberList.maxItems).map(memberVM),
        ...(summary ? { summary } : {}),
        ...(list.parent ? { parent: memberVM(list.parent) } : {}),
        filterOptions: {
            sortBy: cfg.memberList.sortByOptions,
            badgeGroups: cfg.memberList.badgeGroups,
        },
    };
}
