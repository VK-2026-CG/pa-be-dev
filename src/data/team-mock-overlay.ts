/**
 * DEVELOPMENT-ONLY Team Drilldown mock overlay for the Mongo source mode
 * (SPEC-2026-004 D-P4-07-06, requester-approved 2026-09-24).
 *
 * The three approved collections carry no hierarchy/badges/goal status
 * (OQ-79), so source mode alone lists only the caller. With
 * `INSIGHTS_TEAM_DRILLDOWN_MOCK=true` the caller's Team Drilldown is served
 * from the deterministic mock tree (`team-tree.ts`) with the caller as the AM
 * root, and dashboards of those mock members are composed by the memory
 * engine. Every other read — including the caller's own Performance
 * dashboard — still comes from Mongo. Opt-in, off by default, refused in
 * production, and identity stays the Mongo allowlist only
 * (`findIdentityAgent`), so a mock member can never be used as a login.
 */
import type { DataSource, TeamListRequest } from './source.js';
import type { AgentRecord } from './registry.js';
import { teamAgentRecord } from './team-tree.js';
import type { Lens } from './values.js';
import type { Basis, Scope } from '../types.js';

/** The mock tree's AM root (L3001's reports) stands in for the caller's team. */
const MOCK_ROOT = 'L3001';

export function teamDrilldownMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = env.INSIGHTS_TEAM_DRILLDOWN_MOCK === 'true';
  if (on && env.NODE_ENV === 'production') throw new Error('INSIGHTS_TEAM_DRILLDOWN_MOCK is development-only');
  return on;
}

export class TeamDrilldownMockOverlay implements DataSource {
  readonly kind: DataSource['kind'];
  readonly ownIdentityOnly?: boolean;

  constructor(private readonly real: DataSource, private readonly mock: DataSource) {
    this.kind = real.kind;
    this.ownIdentityOnly = real.ownIdentityOnly;
  }

  /** Logins resolve against the real allowlist only. */
  findIdentityAgent(id: string): AgentRecord | undefined {
    return this.real.findIdentityAgent?.(id) ?? this.real.findAgent?.(id);
  }

  /** Domain reads may also target mock team members (viewing mode). */
  findAgent(id: string): AgentRecord | undefined {
    return this.real.findAgent?.(id) ?? teamAgentRecord(id);
  }

  private isMock(agent: AgentRecord): boolean {
    return !this.real.findAgent?.(agent.agentId) && teamAgentRecord(agent.agentId) !== undefined;
  }
  private pick(agent: AgentRecord): DataSource {
    return this.isMock(agent) ? this.mock : this.real;
  }
  private asRoot(agent: AgentRecord): AgentRecord {
    return this.isMock(agent) ? agent : { ...agent, agentId: MOCK_ROOT, level: 'P2' };
  }

  metricList(agent: AgentRecord, l: Lens, listScope: 'PRIORITY' | 'FOCUS' | 'ALL', codes?: string[]) {
    return this.pick(agent).metricList(agent, l, listScope, codes);
  }
  metricDetail(agent: AgentRecord, code: string, l: Lens) { return this.pick(agent).metricDetail(agent, code, l); }
  metricSeries(agent: AgentRecord, code: string, l: Lens, anchorYear: number, yearsBack: number) {
    return this.pick(agent).metricSeries(agent, code, l, anchorYear, yearsBack);
  }
  milestones(agent: AgentRecord) { return this.pick(agent).milestones(agent); }
  getPreferences(agent: AgentRecord, scope: Scope, basis: Basis) { return this.pick(agent).getPreferences(agent, scope, basis); }
  putPreferences(agent: AgentRecord, scope: Scope, basis: Basis, body: { priorityMetricCodes: string[]; focusMetricCodes: string[] }) {
    return this.pick(agent).putPreferences(agent, scope, basis, body);
  }
  recommendations(agent: AgentRecord, scope: Scope) { return this.pick(agent).recommendations(agent, scope); }
  recordFeedback(agent: AgentRecord, recommendationId: string, rating: 'UP' | 'DOWN') {
    return this.pick(agent).recordFeedback(agent, recommendationId, rating);
  }
  listTeamMembers(agent: AgentRecord, req: TeamListRequest) { return this.mock.listTeamMembers(this.asRoot(agent), req); }
  findTeamMember(agent: AgentRecord, memberAgentId: string, lens: Lens) {
    return this.mock.findTeamMember(this.asRoot(agent), memberAgentId, lens);
  }
  getTeamMemberDashboard(agent: AgentRecord, memberAgentId: string, lens: Lens) {
    return this.mock.getTeamMemberDashboard(this.asRoot(agent), memberAgentId, lens);
  }
}
