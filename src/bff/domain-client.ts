/**
 * Insights domain client — now in-process. The BFF and the Insights domain
 * area (`src/data/*`) run in the same Fastify process, so this calls the
 * `DataSource` seam directly instead of looping back over HTTP to itself.
 * Shape mirrors the former HTTP client 1:1 so `src/bff/compose/*` needed no
 * changes beyond the import path.
 */
import type { DataSource } from '../data/source.js';
import { findAgent } from '../data/registry.js';
import type { AgentRecord } from '../data/registry.js';
import { CATALOG, effectiveCatalog } from '../data/catalog.js';
import { ANCHOR_YEAR, type Lens } from '../data/values.js';
import { checkMonthlyRange, isMonthlyAggregation } from '../data/monthly-history.js';
import type {
  MemberBadgeCode, MonthlyHistory, MonthlyHistoryAggregation, TeamMember, TeamMemberDashboard, TeamMemberList, TeamMemberSortBy,
} from '../types.js';

export class DomainError extends Error {
  constructor(public status: number, public code: string, public title: string) {
    super(`${status} ${code} ${title}`);
  }
}

/** Appends the sanitized failure category ("timeout", "network", "authentication") when the source reports one. */
export function withCause(title: string, error: unknown): string {
  const cause = (error as { sourceCause?: string })?.sourceCause;
  return cause ? `${title} (${cause})` : title;
}

async function agentForSource(source: DataSource, agentId: string) {
  try {
    const agent = source.resolveIdentity ? await source.resolveIdentity(agentId) : source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
    if (!agent) throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
    return agent;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof Error && error.message === 'Identity hierarchy source read failed') throw new DomainError(503, 'INS-5030', withCause('Identity source unavailable', error));
    if (error instanceof Error && error.message === 'Malformed identity hierarchy') throw new DomainError(500, 'INS-5000', 'Identity data is invalid');
    throw error;
  }
}

async function identityForSource(source: DataSource, agentId: string): Promise<AgentRecord | undefined> {
  try {
    return source.resolveIdentity ? await source.resolveIdentity(agentId) : source.findAgent ? source.findAgent(agentId) : findAgent(agentId);
  } catch (error) {
    if (error instanceof Error && error.message === 'Identity hierarchy source read failed') throw new DomainError(503, 'INS-5030', withCause('Identity source unavailable', error));
    if (error instanceof Error && error.message === 'Malformed identity hierarchy') throw new DomainError(500, 'INS-5000', 'Identity data is invalid');
    throw error;
  }
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

export interface MonthlyHistoryParams { from: string; to: string; aggregation?: MonthlyHistoryAggregation }

export function createInsightsDomain(source: DataSource) {
  const agentOrThrow = (id: string) => agentForSource(source, id);
  return {
    ownIdentityOnly: source.ownIdentityOnly ?? false,
    resolveIdentity: async (id: string): Promise<AgentRecord | undefined> => identityForSource(source, id),
    // These payloads cross into the BFF composition layer (`src/bff/compose/*`), which — like the
    // former HTTP domain-client — treats them loosely (`any`) rather than binding to the domain's
    // strict internal types (e.g. `MetricDefinition`'s `capabilities` vs. the composers' `Record<string,boolean>`).
    metrics: async (_caller: string, agentId: string, p: LensParams & { listScope?: string; codes?: string }): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      const listScope = (p.listScope ?? 'ALL') as 'PRIORITY' | 'FOCUS' | 'ALL';
      const codes = p.codes ? p.codes.split(',') : undefined;
      const list = await source.metricList(agent, lensOf(p), listScope, codes);
      if (!list) throw new DomainError(404, 'INS-4040', 'No data materialized for this lens');
      return list;
    },
    /** Every catalog metric for the lens as EMPTY (no value, never zero-filled): an agent with no metric rows at all. */
    emptyMetrics: (p: LensParams): any => {
      const lens = lensOf(p);
      // No reporting period exists for this agent; the date is the generation date, not a business date.
      const asOfDate = new Date().toISOString().slice(0, 10);
      return {
        context: { businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope, ...(lens.teamView ? { teamView: lens.teamView } : {}), asOfDate },
        items: effectiveCatalog(lens.scope, lens.basis).map((def) => ({ metricCode: def.metricCode, valueType: def.valueType, asOfDate, dataState: 'EMPTY' })),
      };
    },
    metricDetail: async (_caller: string, agentId: string, code: string, p: LensParams): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      const detail = await source.metricDetail(agent, code, lensOf(p));
      if (!detail) throw new DomainError(404, 'INS-4041', 'Metric not in catalog for this lens');
      return detail;
    },
    series: async (_caller: string, agentId: string, code: string, p: LensParams & { anchorYear?: number; yearsBack?: number }): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      const anchorYear = p.anchorYear ?? ANCHOR_YEAR;
      const yearsBack = p.yearsBack ?? 2;
      const s = await source.metricSeries(agent, code, lensOf(p), anchorYear, yearsBack);
      if (!s) throw new DomainError(404, 'INS-4041', 'Metric has no history for this lens');
      return s;
    },
    /** ARVIJ-1450 `getAgentMonthlyHistory`: validated here too, so the BFF cannot request an unbounded read. */
    monthlyHistory: async (_caller: string, agentId: string, p: MonthlyHistoryParams): Promise<MonthlyHistory> => {
      const agent = await agentOrThrow(agentId);
      const range = checkMonthlyRange(p.from, p.to);
      if (!range.ok || (p.aggregation !== undefined && !isMonthlyAggregation(p.aggregation))) {
        throw new DomainError(400, 'INS-4000', 'Invalid parameter');
      }
      try {
        return await source.monthlyHistory(agent, { from: p.from, to: p.to, ...(p.aggregation ? { aggregation: p.aggregation } : {}) });
      } catch (error) {
        if ((error as { sourceCause?: string })?.sourceCause) throw new DomainError(503, 'INS-5030', withCause('Monthly history source unavailable', error));
        throw error;
      }
    },
    milestones: async (_caller: string, agentId: string): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      return source.milestones(agent);
    },
    definitions: async (agentId: string): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      return { country: agent.tenant, items: CATALOG };
    },
    preferences: async (_caller: string, agentId: string, scope: string): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      return source.getPreferences(agent, scope as Lens['scope'], 'STANDARD');
    },
    putPreferences: async (_caller: string, agentId: string, scope: string, body: unknown) => {
      const agent = await agentOrThrow(agentId);
      const res = await source.putPreferences(agent, scope as Lens['scope'], 'STANDARD', body as { priorityMetricCodes: string[]; focusMetricCodes: string[] });
      if (!res.ok) throw new DomainError(422, res.error.code, 'Preference validation failed');
      return res.prefs;
    },
    recommendations: async (_caller: string, agentId: string, scope: string): Promise<any> => {
      const agent = await agentOrThrow(agentId);
      return source.recommendations(agent, scope as Lens['scope']);
    },
    feedback: async (_caller: string, agentId: string, recommendationId: string, rating: 'UP' | 'DOWN'): Promise<void> => {
      const agent = await agentOrThrow(agentId);
      const ok = await source.recordFeedback(agent, recommendationId, rating);
      if (!ok) throw new DomainError(404, 'INS-4042', 'Unknown recommendation');
    },
    listTeamMembers: async (_caller: string, agentId: string, p: TeamDrilldownParams): Promise<TeamMemberList> => {
      const agent = await agentOrThrow(agentId);
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
      const agent = await agentOrThrow(agentId);
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
      const agent = await agentOrThrow(agentId);
      const detail = await source.getTeamMemberDashboard(agent, memberAgentId, teamDashboardLensOf(p));
      if (!detail) throw new DomainError(404, 'INS-4040', 'Unknown team member for leader');
      return detail;
    },
    getAgentOrganization: async (_caller: string, agentId: string) => {
      if (!source.getAgentOrganization) throw new DomainError(503, 'INS-5030', 'Organization source unavailable');
      let organization;
      try { organization = await source.getAgentOrganization(agentId); }
      catch (error) {
        if (error instanceof Error && ['Hierarchy cycle', 'Malformed hierarchy'].includes(error.message)) {
          throw new DomainError(500, 'INS-5000', 'Organization data is invalid');
        }
        throw new DomainError(503, 'INS-5030', 'Organization source unavailable');
      }
      if (!organization) throw new DomainError(404, 'INS-4040', 'Unknown agent for tenant');
      return organization;
    },
  };
}

export type DomainApi = ReturnType<typeof createInsightsDomain>;
