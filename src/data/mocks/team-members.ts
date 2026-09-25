/** Stub team roster + member preview, shared by MemorySource and the Performance DEV mock fallback. */
import { AGENTS, type AgentRecord } from '../registry.js';
import { metricList, type Lens } from '../values.js';
import type { DrilldownBasis, TeamMemberDashboard, TeamMemberList } from '../../types.js';

const MEMBERS_BY_BASIS: Record<DrilldownBasis, Array<{ agentId: string; displayName: string; roleCode: string }>> = {
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

export function mockTeamMembers(basis: DrilldownBasis, query?: string): TeamMemberList {
  const normalizedQuery = query?.trim().toLowerCase() ?? '';
  const items = MEMBERS_BY_BASIS[basis]
    .filter((m) => !normalizedQuery
      || m.agentId.toLowerCase().includes(normalizedQuery) || m.displayName.toLowerCase().includes(normalizedQuery))
    .map((m) => ({ ...m, hierarchyBasis: basis }));
  return { asOfDate: '2026-07-27', items };
}

export function mockTeamMemberDashboard(memberAgentId: string, lens: Lens): TeamMemberDashboard | undefined {
  const member: AgentRecord | undefined = AGENTS.find((a) => a.agentId === memberAgentId);
  if (!member) return undefined;
  const list = metricList({ ...lens, scope: 'SELF' }, 'PRIORITY', ['TPC', 'PTPC']);
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
    metrics: list.items.filter((item) => item.metricCode === 'TPC' || item.metricCode === 'PTPC').slice(0, 2),
  };
}
