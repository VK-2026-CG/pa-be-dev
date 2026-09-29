/**
 * Insights domain client — now in-process. The BFF and the Insights domain
 * area (`src/data/*`) run in the same Fastify process, so this calls the
 * `DataSource` seam directly instead of looping back over HTTP to itself.
 * Shape mirrors the former HTTP client 1:1 so `src/bff/compose/*` needed no
 * changes beyond the import path.
 */
import type { DataSource } from '../data/source.js';
import { findAgent } from '../data/registry.js';
import { CATALOG } from '../data/catalog.js';
import { ANCHOR_YEAR, type Lens } from '../data/values.js';
import type { MemberBadgeCode, TeamMember, TeamMemberDashboard, TeamMemberList, TeamMemberSortBy } from '../types.js';

export class DomainError extends Error {
  constructor(public status: number, public code: string, public title: string) {
    super(`${status} ${code} ${title}`);
  }
}

function agentForSource(source: DataSource, agentId: string) {
  const agent = source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
  if (!agent) throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
  return agent;
}

function lensOf(p: LensParams): Lens {
  return {
    period: (p.period ?? 'YTD') as Lens['period'],
    businessLine: (p.businessLine ?? 'ALL') as Lens['businessLine'],
    basis: (p.basis ?? 'STANDARD') as Lens['basis'],
    scope: (p.scope ?? 'SELF') as Lens['scope'],
    ...(p.teamView ? { teamView: p.teamView as Lens['teamView'] } : {}),
  };
}

export interface LensParams {
  period?: string; businessLine?: string; basis?: string; scope?: string; teamView?: string;
}

export interface TeamDrilldownParams {
  teamView?: string;
  /** Drilldown hierarchy axis (`AGENT|AM|UM`), distinct from Performance `basis`. Absent ⇒ all levels (1.6.0). */
  basis?: string;
  query?: string;
  period?: string;
  businessLine?: string;
  performanceBasis?: string;
  /** 1.6.0 — validated by the BFF. */
  sortBy?: TeamMemberSortBy;
  badges?: MemberBadgeCode[];
  parentMemberAgentId?: string;
}

function teamDashboardLensOf(p: TeamDrilldownParams): Lens {
  return {
    period: (p.period ?? 'YTD') as Lens['period'],
    businessLine: (p.businessLine ?? 'ALL') as Lens['businessLine'],
    basis: (p.performanceBasis ?? 'STANDARD') as Lens['basis'],
    scope: 'TEAM',
    teamView: (p.teamView ?? 'DIRECT') as Lens['teamView'],
  };
}

export function createInsightsDomain(source: DataSource) {
  const agentOrThrow = (id: string) => agentForSource(source, id);
  return {
    // These payloads cross into the BFF composition layer (`src/bff/compose/*`), which — like the
    // former HTTP domain-client — treats them loosely (`any`) rather than binding to the domain's
    // strict internal types (e.g. `MetricDefinition`'s `capabilities` vs. the composers' `Record<string,boolean>`).
    metrics: async (_caller: string, agentId: string, p: LensParams & { listScope?: string; codes?: string }): Promise<any> => {
      const agent = agentOrThrow(agentId);
      const listScope = (p.listScope ?? 'ALL') as 'PRIORITY' | 'FOCUS' | 'ALL';
      const codes = p.codes ? p.codes.split(',') : undefined;
      const list = await source.metricList(agent, lensOf(p), listScope, codes);
      if (!list) throw new DomainError(404, 'INS-4040', 'No data materialized for this lens');
      return list;
    },
    metricDetail: async (_caller: string, agentId: string, code: string, p: LensParams): Promise<any> => {
      const agent = agentOrThrow(agentId);
      const detail = await source.metricDetail(agent, code, lensOf(p));
      if (!detail) throw new DomainError(404, 'INS-4041', 'Metric not in catalog for this lens');
      return detail;
    },
    series: async (_caller: string, agentId: string, code: string, p: LensParams & { anchorYear?: number; yearsBack?: number }): Promise<any> => {
      const agent = agentOrThrow(agentId);
      const anchorYear = p.anchorYear ?? ANCHOR_YEAR;
      const yearsBack = p.yearsBack ?? 2;
      const s = await source.metricSeries(agent, code, lensOf(p), anchorYear, yearsBack);
      if (!s) throw new DomainError(404, 'INS-4041', 'Metric has no history for this lens');
      return s;
    },
    milestones: async (_caller: string, agentId: string): Promise<any> => {
      const agent = agentOrThrow(agentId);
      return source.milestones(agent);
    },
    definitions: async (agentId: string): Promise<any> => {
      const agent = agentOrThrow(agentId);
      return { country: agent.tenant, items: CATALOG };
    },
    preferences: async (_caller: string, agentId: string, scope: string): Promise<any> => {
      const agent = agentOrThrow(agentId);
      return source.getPreferences(agent, scope as Lens['scope'], 'STANDARD');
    },
    putPreferences: async (_caller: string, agentId: string, scope: string, body: unknown) => {
      const agent = agentOrThrow(agentId);
      const res = await source.putPreferences(agent, scope as Lens['scope'], 'STANDARD', body as { priorityMetricCodes: string[]; focusMetricCodes: string[] });
      if (!res.ok) throw new DomainError(422, res.error.code, 'Preference validation failed');
      return res.prefs;
    },
    recommendations: async (_caller: string, agentId: string, scope: string): Promise<any> => {
      const agent = agentOrThrow(agentId);
      return source.recommendations(agent, scope as Lens['scope']);
    },
    feedback: async (_caller: string, agentId: string, recommendationId: string, rating: 'UP' | 'DOWN'): Promise<void> => {
      const agent = agentOrThrow(agentId);
      const ok = await source.recordFeedback(agent, recommendationId, rating);
      if (!ok) throw new DomainError(404, 'INS-4042', 'Unknown recommendation');
    },
    listTeamMembers: async (_caller: string, agentId: string, p: TeamDrilldownParams): Promise<TeamMemberList> => {
      const agent = agentOrThrow(agentId);
      const list = await source.listTeamMembers(agent, {
        teamView: (p.teamView ?? 'DIRECT') as 'DIRECT' | 'GROUP',
        ...(p.basis ? { basis: p.basis as 'AGENT' | 'AM' | 'UM' } : {}),
        ...(p.query ? { query: p.query } : {}),
        sortBy: p.sortBy ?? 'TPC',
        ...(p.badges?.length ? { badges: p.badges } : {}),
        ...(p.parentMemberAgentId ? { parentMemberAgentId: p.parentMemberAgentId } : {}),
        lens: { ...teamDashboardLensOf(p), scope: 'SELF' },
      });
      if (!list) throw new DomainError(403, 'INS-4030', 'Member is not in the caller\'s downline');
      return list;
    },
    /** Downline membership check (D-14) + the record used to compose a viewed member's dashboard. */
    findTeamMember: async (_caller: string, agentId: string, memberAgentId: string): Promise<{ member: TeamMember; agentId: string; level: 'P2' | 'P3' | 'P4' }> => {
      const agent = agentOrThrow(agentId);
      const found = await source.findTeamMember(agent, memberAgentId, { period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' });
      if (!found) throw new DomainError(403, 'INS-4030', 'Member is not in the caller\'s downline');
      return { member: found.member, agentId: found.record.agentId, level: found.record.level };
    },
    getTeamMemberDashboard: async (
      _caller: string,
      agentId: string,
      memberAgentId: string,
      p: TeamDrilldownParams,
    ): Promise<TeamMemberDashboard> => {
      const agent = agentOrThrow(agentId);
      const detail = await source.getTeamMemberDashboard(agent, memberAgentId, teamDashboardLensOf(p));
      if (!detail) throw new DomainError(404, 'INS-4040', 'Unknown team member for leader');
      return detail;
    },
  };
}

export type DomainApi = ReturnType<typeof createInsightsDomain>;
