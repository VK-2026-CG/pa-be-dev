/**
 * S-P4-07 Team Drilldown composer (spec 0.2.0, SPEC-2026-004): "My Team" list
 * with card fields, KPI tiles over the filtered set, filter options from C4,
 * the subteam drawer (`parentAgentId`) and member → S-P4-01 viewing-mode nav.
 */
import type {
  DrilldownBasis, MetricCardVM, MemberBadgeCode, TeamDrilldownSortBy, TeamDrilldownVM, TeamMemberVM, TeamView,
} from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import type { Persona } from '../persona.js';
import type { TeamMember } from '../../types.js';
import { TEAM_DRILLDOWN_CONFIG } from '../config.js';
import { buildMeta } from './shared.js';

export interface TeamDrilldownInput {
  teamView: TeamView;
  basis?: DrilldownBasis;
  search?: string;
  sortBy: TeamDrilldownSortBy;
  badges: MemberBadgeCode[];
  parentAgentId?: string;
  period: 'MTD' | 'QTD' | 'YTD';
  businessLine: 'ALL' | 'INSURANCE' | 'TAKAFUL';
  performanceBasis: 'STANDARD' | 'SCHEME';
}

function memberVM(m: TeamMember): TeamMemberVM {
  return {
    ...m,
    nav: { route: 'insights/performance', params: { subjectAgentId: m.agentId } },
  };
}

export async function composeTeamDrilldown(
  api: DomainApi,
  persona: Persona,
  input: TeamDrilldownInput,
): Promise<Omit<TeamDrilldownVM, 'selectedMember'>> {
  const list = await api.listTeamMembers(persona.agentId, persona.agentId, {
    teamView: input.teamView,
    ...(input.basis ? { basis: input.basis } : {}),
    ...(input.search ? { query: input.search } : {}),
    period: input.period,
    businessLine: input.businessLine,
    performanceBasis: input.performanceBasis,
    sortBy: input.sortBy,
    badges: input.badges as TeamMember['badges'],
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
            : metricCode === 'PRODUCTIVITY' ? 'DECIMAL' : 'MONEY')) as MetricCardVM['valueType'];
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
