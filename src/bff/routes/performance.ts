import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Scope } from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import { composeDashboard, composeViewingDashboard } from '../compose/dashboard.js';
import { composeCustomize } from '../compose/customize.js';
import { composeMetricDetail } from '../compose/metric-detail.js';
import { composeHistory } from '../compose/history.js';
import { buildMeta } from '../compose/shared.js';
import { CONFIG, FILTERABLE_BADGES, TEAM_DRILLDOWN_CONFIG } from '../config.js';
import { composeTeamDrilldown } from '../compose/team-drilldown.js';
import type { MemberBadgeCode } from '../../../vendor/spec/performance-vm.js';
import { isLeader } from '../persona.js';
import { getPersona as resolvePersona, mapDomainError, parseLens, problem } from '../bff.js';

function scopeOf(req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>): Scope {
  return (req.query.scope ?? 'SELF') as Scope;
}

function cardFromSnapshot(
  snap: {
    metricCode: string;
    valueType: 'MONEY' | 'COUNT' | 'PERCENT' | 'DECIMAL';
    variant?: 'WITHOUT_REPRICING' | 'WITH_REPRICING';
    dataState?: 'OK' | 'PROCESSING' | 'EMPTY';
    notices?: Array<{ code: string; severity: 'INFO' | 'WARNING'; params?: Record<string, string> }>;
    collected?: unknown;
    goal?: unknown;
    comparison?: {
      basis: 'LAST_YEAR';
      direction: 'UP' | 'DOWN' | 'FLAT';
      sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
      pct?: number;
      pp?: number;
      abs?: unknown;
    };
    asOfDate?: string;
  },
  filters: {
    period: string;
    businessLine: string;
    basis: string;
    teamView: string;
  },
) {
  const dataState = snap.dataState ?? 'OK';
  const isOk = dataState === 'OK';
  return {
    metricCode: snap.metricCode,
    valueType: snap.valueType,
    ...(snap.variant ? { variant: snap.variant } : {}),
    ...(isOk ? {} : { dataState }),
    ...(isOk && snap.collected !== undefined ? { value: snap.collected } : {}),
    ...(snap.notices?.length ? { notices: snap.notices } : {}),
    showGoal: snap.metricCode !== 'PTPC',
    ...(isOk && snap.goal !== undefined ? { goal: snap.goal } : {}),
    ...(isOk && snap.comparison
      ? {
          delta: {
            comparisonBasis: snap.comparison.basis,
            direction: snap.comparison.direction,
            sentiment: snap.comparison.sentiment,
            display: snap.comparison.abs !== undefined ? 'ABS' : snap.comparison.pp !== undefined ? 'PP' : 'PCT',
            ...(snap.comparison.pct !== undefined ? { pct: snap.comparison.pct } : {}),
            ...(snap.comparison.pp !== undefined ? { pp: snap.comparison.pp } : {}),
            ...(snap.comparison.abs !== undefined ? { abs: snap.comparison.abs } : {}),
          },
        }
      : {}),
    nav: {
      route: 'insights/metric-detail',
      params: {
        metricCode: snap.metricCode,
        period: filters.period,
        businessLine: filters.businessLine,
        basis: filters.basis,
        scope: 'TEAM',
        teamView: filters.teamView,
      },
    },
  };
}

export function registerPerformanceRoutes(app: FastifyInstance, domain: DomainApi & { ownIdentityOnly?: boolean }): void {
  const getPersona = (request: FastifyRequest) => resolvePersona(request, domain);
  app.get<{ Params: { agentId: string } }>('/insights/v1/agents/:agentId/organization', async (req, reply) => {
    const persona = await getPersona(req);
    if (req.headers['x-tenant'] && req.headers['x-tenant'] !== 'MY') return problem(reply, 401, 'INS-4010', 'Unknown caller identity');
    if (req.params.agentId !== persona.agentId) return problem(reply, 403, 'INS-4030', 'Agent may only read own organization');
    if (!isLeader(persona)) return problem(reply, 403, 'INS-4030', 'Organization access requires a leader persona');
    try { return await domain.getAgentOrganization(persona.agentId, req.params.agentId); }
    catch (error) { return mapDomainError(reply, error); }
  });

  app.get('/api/bff/v1/performance/dashboard', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const subjectAgentId = req.query.subjectAgentId?.trim();
    if (subjectAgentId !== undefined) {
      // S-P4-01 2.1.0 viewing mode (AC-P4-01-82..84): leaders only, downline members only, read-only.
      if (!isLeader(persona)) return problem(reply, 403, 'BFF-4032', 'Viewing a member requires a leader persona');
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(subjectAgentId)) return problem(reply, 400, 'BFF-4000', 'Invalid subjectAgentId', subjectAgentId);
      // scope/teamView are decided by the member's role, never by the query (AC-P4-01-83).
      const { scope: _s, teamView: _t, ...query } = req.query;
      const lens = parseLens(query, persona, reply);
      if (!lens) return;
      try {
        const member = await domain.findTeamMember(persona.agentId, persona.agentId, subjectAgentId);
        return await composeViewingDashboard(domain, member, { period: lens.period, businessLine: lens.businessLine, basis: lens.basis });
      } catch (e) {
        const err = e as { status?: number; code?: string };
        if (err.status === 403 && err.code === 'INS-4030') return problem(reply, 403, 'BFF-4033', 'Member is not in the caller\'s team');
        return mapDomainError(reply, e);
      }
    }
    const lens = parseLens(req.query, persona, reply);
    if (!lens) return;
    try {
      return await composeDashboard(domain, persona, lens);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/customize', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const scope = scopeOf(req);
    if (scope === 'TEAM' && !isLeader(persona)) return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
    try {
      return await composeCustomize(domain, persona, scope);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.put('/api/bff/v1/performance/customize', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined>; Body: unknown }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const scope = scopeOf(req);
    if (scope === 'TEAM' && !isLeader(persona)) return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
    const body = req.body;
    if (!body || typeof body !== 'object') return problem(reply, 400, 'BFF-4001', 'Body must be JSON');
    try {
      await domain.putPreferences(persona.agentId, persona.agentId, scope, body);
      return await composeCustomize(domain, persona, scope);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/metrics/:metricCode', async (req: FastifyRequest<{ Params: { metricCode: string }; Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const lens = parseLens(req.query, persona, reply);
    if (!lens) return;
    try {
      return await composeMetricDetail(domain, persona, req.params.metricCode, lens);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/metrics/:metricCode/history', async (req: FastifyRequest<{ Params: { metricCode: string }; Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const lens = parseLens(req.query, persona, reply);
    if (!lens) return;
    const window = (req.query.window ?? CONFIG.screens.history.defaultWindow) as typeof CONFIG.screens.history.defaultWindow;
    if (!CONFIG.screens.history.windows.includes(window)) {
      return problem(reply, 400, 'BFF-4000', 'Invalid window', window);
    }
    try {
      return await composeHistory(domain, persona, req.params.metricCode, lens, window);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.post('/api/bff/v1/performance/recommendations/:recommendationId/feedback', async (req: FastifyRequest<{ Params: { recommendationId: string }; Body: { rating?: unknown } }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    const rating = req.body?.rating;
    if (rating !== 'UP' && rating !== 'DOWN') return problem(reply, 400, 'BFF-4002', 'rating must be UP or DOWN');
    try {
      await domain.feedback(persona.agentId, persona.agentId, req.params.recommendationId, rating);
      return reply.status(204).send();
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/team-drilldown', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = await getPersona(req);
    if (!isLeader(persona)) return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');

    const teamView = (req.query.teamView ?? 'DIRECT') as 'DIRECT' | 'GROUP';
    if (teamView !== 'DIRECT' && teamView !== 'GROUP') return problem(reply, 400, 'BFF-4000', 'Invalid teamView', String(req.query.teamView));
    if (teamView === 'GROUP' && persona.level !== 'P2') {
      return problem(reply, 403, 'BFF-4031', 'teamView=GROUP requires a P2-level leader');
    }

    // 1.6.0: an omitted basis lists every hierarchy level (S-P4-07 "My Team").
    const hierarchyBasis = req.query.basis as 'AGENT' | 'AM' | 'UM' | undefined;
    if (hierarchyBasis !== undefined && hierarchyBasis !== 'AGENT' && hierarchyBasis !== 'AM' && hierarchyBasis !== 'UM') {
      return problem(reply, 400, 'BFF-4000', 'Invalid basis', String(req.query.basis));
    }
    const sortBy = (req.query.sortBy ?? TEAM_DRILLDOWN_CONFIG.memberList.defaultSortBy) as 'TPC' | 'PTPC';
    if (!TEAM_DRILLDOWN_CONFIG.memberList.sortByOptions.includes(sortBy)) {
      return problem(reply, 400, 'BFF-4000', 'Invalid sortBy', String(req.query.sortBy));
    }
    const badges = (req.query.badges ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    const badBadge = badges.find((b) => !FILTERABLE_BADGES.has(b));
    if (badBadge) return problem(reply, 400, 'BFF-4000', 'Invalid badges', badBadge);
    const parentAgentId = req.query.parentAgentId?.trim() || undefined;
    if (parentAgentId && !/^[A-Za-z0-9_-]{3,32}$/.test(parentAgentId)) {
      return problem(reply, 400, 'BFF-4000', 'Invalid parentAgentId', parentAgentId);
    }

    const period = (req.query.period ?? 'YTD') as 'MTD' | 'QTD' | 'YTD';
    if (period !== 'MTD' && period !== 'QTD' && period !== 'YTD') {
      return problem(reply, 400, 'BFF-4000', 'Invalid period', String(req.query.period));
    }
    const businessLine = (req.query.businessLine ?? 'ALL') as 'ALL' | 'INSURANCE' | 'TAKAFUL';
    if (businessLine !== 'ALL' && businessLine !== 'INSURANCE' && businessLine !== 'TAKAFUL') {
      return problem(reply, 400, 'BFF-4000', 'Invalid businessLine', String(req.query.businessLine));
    }
    const performanceBasis = (req.query.performanceBasis ?? req.query.metricBasis ?? 'STANDARD') as 'STANDARD' | 'SCHEME';
    if (performanceBasis !== 'STANDARD' && performanceBasis !== 'SCHEME') {
      return problem(reply, 400, 'BFF-4000', 'Invalid performanceBasis', String(req.query.performanceBasis ?? req.query.metricBasis));
    }

    const search = req.query.query?.trim() || undefined;
    const selectedAgentId = req.query.selectedAgentId?.trim() || undefined;

    try {
      const vm = await composeTeamDrilldown(domain, persona, {
        teamView,
        ...(hierarchyBasis ? { basis: hierarchyBasis } : {}),
        ...(search ? { search } : {}),
        sortBy,
        badges: badges as MemberBadgeCode[],
        ...(parentAgentId ? { parentAgentId } : {}),
        period,
        businessLine,
        performanceBasis,
      });

      // 0.1.0 selected-member preview — superseded in the UI by S-P4-01 viewing mode (AC-P4-07-04), kept for compatibility.
      if (selectedAgentId) {
        const dashboard = await domain.getTeamMemberDashboard(persona.agentId, persona.agentId, selectedAgentId, {
          teamView,
          ...(hierarchyBasis ? { basis: hierarchyBasis } : {}),
          period,
          businessLine,
          performanceBasis,
        });
        return {
          ...vm,
          meta: buildMeta('S-P4-07', dashboard.context.asOfDate),
          selectedMember: {
            member: dashboard.member,
            context: {
              period: dashboard.context.period.type,
              businessLine: dashboard.context.businessLine,
              basis: dashboard.context.basis,
              scope: 'TEAM',
              teamView,
              asOfDate: dashboard.context.asOfDate,
            },
            metrics: dashboard.metrics.map((m) => cardFromSnapshot(m, { period, businessLine, basis: performanceBasis, teamView })),
          },
        };
      }
      return vm;
    } catch (e) {
      const err = e as { status?: number; code?: string };
      if (err.status === 403 && err.code === 'INS-4030') {
        return problem(reply, 403, 'BFF-4033', 'Member is not in the caller\'s team');
      }
      return mapDomainError(reply, e);
    }
  });

  /**
   * DRAFT (S-P4-05, specVersion 0.9.0): proposed BenefitCardVM payload behind
   * the draft flag — the benefits domain contract is OQ-17/18. Data mirrors the
   * P4-uplift mock. Do NOT extend without a spec ruling.
   */
  app.get('/api/bff/v1/benefits', async () => ({
    draft: true,
    tabs: ['BONUS', 'CONTESTS'],
    bonus: [
      {
        benefitCode: 'HPFB', title: 'High Producer Fringe Benefit (HPFB)',
        rate: { pct: 3, sentiment: 'POSITIVE' }, assessmentYear: 2026,
        progress: {
          min: { kind: 'MONEY', amount: '60000.00', currency: 'MYR' },
          current: { kind: 'MONEY', amount: '70000.00', currency: 'MYR' },
          max: { kind: 'MONEY', amount: '89000.00', currency: 'MYR' },
        },
        pinned: false,
      },
      { benefitCode: 'HPFB', title: 'High Performance Fringe Benefit (HPFB)', rate: { pct: 3, sentiment: 'POSITIVE' }, assessmentYear: 2026, statusSentiment: 'POSITIVE', pinned: false },
      { benefitCode: 'HPFB', title: 'High Performance Fringe Benefit (HPFB)', rate: { pct: 0, sentiment: 'NEGATIVE' }, assessmentYear: 2026, statusSentiment: 'NEGATIVE', pinned: false },
    ],
    contests: [],
  }));

  /**
   * DRAFT (S-P4-06, specVersion 0.9.0): proposed CompBonusRowVM payload —
   * compensation domain ownership is OQ-18. Data mirrors the P4-uplift mock,
   * incl. the stale-data banner variant (?stale=1).
   */
  app.get('/api/bff/v1/compensation', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>) => {
    const stale = req.query.stale === '1';
    return {
      draft: true,
      tabs: ['PAID_COMMISSION', 'RETIREMENT'],
      ...(stale ? { staleness: { asOnDate: '2026-03-09' } } : {}),
      rows: [
        { bonusCode: 'PERSISTENCY_BONUS_Y1', amount: { kind: 'MONEY', amount: '45000.00', currency: 'MYR' }, status: 'PAID', paidOn: '2026-08-12' },
        { bonusCode: 'PERSISTENCY_BONUS_Y2', amount: { kind: 'MONEY', amount: '27000.00', currency: 'MYR' }, status: 'PENDING' },
        { bonusCode: 'HPFB', amount: { kind: 'MONEY', amount: '33495.70', currency: 'MYR' }, status: 'PENDING' },
      ],
      retirement: [],
    };
  });
}
