import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Scope } from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import { composeDashboard } from '../compose/dashboard.js';
import { composeCustomize } from '../compose/customize.js';
import { composeMetricDetail } from '../compose/metric-detail.js';
import { composeHistory } from '../compose/history.js';
import { CONFIG } from '../config.js';
import { isLeader } from '../persona.js';
import { getPersona, mapDomainError, parseLens, problem } from '../bff.js';

function scopeOf(req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>): Scope {
  return (req.query.scope ?? 'SELF') as Scope;
}

export function registerPerformanceRoutes(app: FastifyInstance, domain: DomainApi): void {
  app.get('/api/bff/v1/performance/dashboard', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = getPersona(req);
    const lens = parseLens(req.query, persona, reply);
    if (!lens) return;
    try {
      return await composeDashboard(domain, persona, lens);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/customize', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = getPersona(req);
    const scope = scopeOf(req);
    if (scope === 'TEAM' && !isLeader(persona)) return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
    try {
      return await composeCustomize(domain, persona, scope);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.put('/api/bff/v1/performance/customize', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined>; Body: unknown }>, reply: FastifyReply) => {
    const persona = getPersona(req);
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
    const persona = getPersona(req);
    const lens = parseLens(req.query, persona, reply);
    if (!lens) return;
    try {
      return await composeMetricDetail(domain, persona, req.params.metricCode, lens);
    } catch (e) {
      return mapDomainError(reply, e);
    }
  });

  app.get('/api/bff/v1/performance/metrics/:metricCode/history', async (req: FastifyRequest<{ Params: { metricCode: string }; Querystring: Record<string, string | undefined> }>, reply: FastifyReply) => {
    const persona = getPersona(req);
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
    const persona = getPersona(req);
    const rating = req.body?.rating;
    if (rating !== 'UP' && rating !== 'DOWN') return problem(reply, 400, 'BFF-4002', 'rating must be UP or DOWN');
    try {
      await domain.feedback(persona.agentId, persona.agentId, req.params.recommendationId, rating);
      return reply.status(204).send();
    } catch (e) {
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
