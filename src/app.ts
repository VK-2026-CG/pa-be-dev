import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { parse as parseYaml } from 'yaml';
import type { OpenAPIV3 } from 'openapi-types';
import { findAgent, type AgentRecord } from './data/registry.js';
import { CATALOG, effectiveCatalog } from './data/catalog.js';
import { ANCHOR_YEAR, contextFor, type Lens } from './data/values.js';
import type { DataSource } from './data/source.js';
import { PerformanceSourceNotFound } from './data/performance-record.js';
import { withCause } from './bff/domain-client.js';import type { Basis, BusinessLine, PeriodType, Problem, Scope, TeamView } from './types.js';
import { checkMonthlyRange, isMonthlyAggregation } from './data/monthly-history.js';
import { SpecContestRepository } from './contest/spec-repository.js';
import { registerSpecContestRoutes } from './contest/spec-routes.js';
import { createContestBrochureStore, type ContestBrochureStore } from './contest/brochure-store.js';
import { ContestBrochureImportService } from './contest/brochure-import.js';
import { createBrochureInferenceProvider, type ContestBrochureInferenceProvider } from './contest/brochure-import-provider.js';
import { registerBffRoutes } from './bff/index.js';

function loadSpec(fileName: string): OpenAPIV3.Document {
  const path = fileURLToPath(new URL(`../vendor/spec/${fileName}`, import.meta.url));
  return parseYaml(readFileSync(path, 'utf8')) as OpenAPIV3.Document;
}

const PERIODS = new Set(['MTD', 'QTD', 'YTD']);
const BLS = new Set(['ALL', 'INSURANCE', 'TAKAFUL']);
const BASES = new Set(['STANDARD', 'SCHEME']);
const SCOPES = new Set(['SELF', 'TEAM']);
const TVS = new Set(['DIRECT', 'GROUP']);

function problem(reply: FastifyReply, status: number, code: string, title: string, detail?: string) {
  const body: Problem = { title, status, code, ...(detail ? { detail } : {}) };
  return reply.status(status).type('application/problem+json').send(body);
}

interface Caller { agent: AgentRecord }

/** Stub auth: trusts x-agent-id / x-tenant headers (the BFF's stub JWT). */
type IdentityResolver = (id: string) => Promise<AgentRecord | undefined>;

async function callerFor(req: FastifyRequest, reply: FastifyReply, resolveAgent: IdentityResolver, ownIdentityOnly = false): Promise<Caller | null> {
  if (ownIdentityOnly && (!req.headers['x-agent-id'] || (req.headers['x-tenant'] && req.headers['x-tenant'] !== 'MY'))) {
    void problem(reply, 401, 'INS-4010', 'Development identity required'); return null;
  }
  const agentId = (req.headers['x-agent-id'] as string | undefined) ?? 'A1001';
  let agent: AgentRecord | undefined;
  try { agent = await resolveAgent(agentId); } catch (e) { problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); return null; }
  if (!agent) {
    void problem(reply, 401, 'INS-4010', 'Unknown caller identity');
    return null;
  }
  const target = (req.params as { agentId?: string } | undefined)?.agentId;
  if (ownIdentityOnly && target && target !== agent.agentId) {
    void problem(reply, 403, 'INS-4030', 'Agent may only read own data'); return null;
  }
  return { agent };
}

interface LensQuery {
  period?: string; businessLine?: string; basis?: string; scope?: string; teamView?: string;
}

/** Authenticate the caller and resolve the `:agentId` path agent (404 unknown; a P4 caller may only read itself). Null after replying on error. */
async function pathAgentFor(req: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply, resolveAgent: IdentityResolver, ownIdentityOnly = false): Promise<AgentRecord | null> {
  const c = await callerFor(req, reply, resolveAgent, ownIdentityOnly);
  if (!c) return null;
  let pathAgent: AgentRecord | undefined;
  try { pathAgent = await resolveAgent(req.params.agentId); } catch (e) { problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); return null; }
  if (!pathAgent) { void problem(reply, 404, 'INS-4040', 'Unknown agent for tenant'); return null; }
  if (pathAgent.agentId !== c.agent.agentId && c.agent.level === 'P4') {
    void problem(reply, 403, 'INS-4030', 'Agent may only read own data'); return null;
  }
  return pathAgent;
}

/** Parse + authorize the standard lens params. Returns null after replying on error. */
async function lensFor(req: FastifyRequest<{ Querystring: LensQuery; Params: { agentId: string } }>, reply: FastifyReply, resolveAgent: IdentityResolver, ownIdentityOnly = false): Promise<(Lens & Caller) | null> {
  const pathAgent = await pathAgentFor(req, reply, resolveAgent, ownIdentityOnly);
  if (!pathAgent) return null;
  const q = req.query;
  const period = (q.period ?? 'YTD') as PeriodType;
  const businessLine = (q.businessLine ?? 'ALL') as BusinessLine;
  const basis = (q.basis ?? 'STANDARD') as Basis;
  const scope = (q.scope ?? 'SELF') as Scope;
  const teamView = (q.teamView ?? (scope === 'TEAM' ? 'DIRECT' : undefined)) as TeamView | undefined;
  for (const [name, val, set] of [
    ['period', period, PERIODS], ['businessLine', businessLine, BLS], ['basis', basis, BASES], ['scope', scope, SCOPES],
  ] as const) {
    if (!set.has(val)) { void problem(reply, 400, 'INS-4000', 'Invalid parameter', `${name}=${val}`); return null; }
  }
  if (teamView !== undefined && !TVS.has(teamView)) {
    void problem(reply, 400, 'INS-4000', 'Invalid parameter', `teamView=${teamView}`); return null;
  }
  // Scope/level gating (D-14, ruling 2026-08): TEAM needs a leader; GROUP needs P2.
  if (scope === 'TEAM' && pathAgent.level === 'P4') {
    void problem(reply, 403, 'INS-4032', 'scope=TEAM requires a leader (P2/P3)'); return null;
  }
  if (scope === 'TEAM' && teamView === 'GROUP' && pathAgent.level !== 'P2') {
    void problem(reply, 403, 'INS-4031', 'teamView=GROUP requires a P2-level leader'); return null;
  }
  return { period, businessLine, basis, scope, ...(scope === 'TEAM' ? { teamView } : {}), agent: pathAgent };
}

export function buildApp(source: DataSource, specContestRepository = new SpecContestRepository(),brochureStore:ContestBrochureStore=createContestBrochureStore(),inferenceProvider:ContestBrochureInferenceProvider=createBrochureInferenceProvider()) {
  const resolveAgent: IdentityResolver = (id) => source.resolveIdentity ? source.resolveIdentity(id) : Promise.resolve(source.findAgent?.(id) ?? findAgent(id));
  const caller = (req: FastifyRequest, reply: FastifyReply) => callerFor(req, reply, resolveAgent, source.ownIdentityOnly);
  const lens = (req: FastifyRequest<{ Querystring: LensQuery; Params: { agentId: string } }>, reply: FastifyReply) => lensFor(req, reply, resolveAgent, source.ownIdentityOnly);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PerformanceSourceNotFound) return problem(reply, error.status, error.code, error.title);
    return reply.send(error); // Preserve Fastify's existing handling for other routes.
  });
  void app.register(cors, { origin: true });
  void app.register(multipart);

  void app.register(async (instance) => {
    void instance.register(fastifySwagger, { mode: 'static', specification: { document: loadSpec('insights.v1.yaml') } });
    void instance.register(fastifySwaggerUi, { routePrefix: '/docs' });
  });
  void app.register(async (instance) => {
    void instance.register(fastifySwagger, { mode: 'static', specification: { document: loadSpec('contests.v1.yaml') } });
    void instance.register(fastifySwaggerUi, { routePrefix: '/docs/contests' });
  });

  app.get('/healthz', async () => ({ ok: true, service: 'pruaction-insights-service', spec: '1.4.0' }));
  registerSpecContestRoutes(app, specContestRepository,brochureStore,new ContestBrochureImportService(specContestRepository,brochureStore,inferenceProvider));
  registerBffRoutes(app, source);

  app.get<{ Params: { agentId: string }; Querystring: LensQuery & { scope2?: string; codes?: string; listScope?: string } }>(
    '/insights/v1/agents/:agentId/metrics',
    async (req, reply) => {
      const l = await lens(req, reply); if (!l) return;
      const raw = (req.query as Record<string, string | undefined>);
      const listScope = (raw.listScope ?? 'ALL') as 'PRIORITY' | 'FOCUS' | 'ALL';
      const codes = raw.codes ? raw.codes.split(',') : undefined;
      const list = await source.metricList(l.agent, l, listScope, codes);
      if (!list) return problem(reply, 404, 'INS-4040', 'No data materialized for this lens');
      return list;
    },
  );

  app.get<{ Params: { agentId: string; metricCode: string }; Querystring: LensQuery }>(
    '/insights/v1/agents/:agentId/metrics/:metricCode',
    async (req, reply) => {
      const l = await lens(req, reply); if (!l) return;
      const detail = await source.metricDetail(l.agent, req.params.metricCode, l);
      if (!detail) return problem(reply, 404, 'INS-4041', 'Metric not in catalog for this lens', req.params.metricCode);
      return detail;
    },
  );

  app.get<{ Params: { agentId: string; metricCode: string }; Querystring: LensQuery & { anchorYear?: string; yearsBack?: string } }>(
    '/insights/v1/agents/:agentId/metrics/:metricCode/series',
    async (req, reply) => {
      const l = await lens(req, reply); if (!l) return;
      const anchorYear = req.query.anchorYear ? Number(req.query.anchorYear) : ANCHOR_YEAR;
      const yearsBack = req.query.yearsBack !== undefined ? Number(req.query.yearsBack) : 2;
      if (!Number.isInteger(yearsBack) || yearsBack < 0 || yearsBack > 4) {
        return problem(reply, 400, 'INS-4000', 'Invalid parameter', `yearsBack=${req.query.yearsBack}`);
      }
      const s = await source.metricSeries(l.agent, req.params.metricCode, l, anchorYear, yearsBack);
      if (!s) return problem(reply, 404, 'INS-4041', 'Metric has no history for this lens', req.params.metricCode);
      return s;
    },
  );

  // ARVIJ-1450 (docs/monthly-history-source.md): month-level values from both source databases, no aggregation fallback.
  app.get<{ Params: { agentId: string }; Querystring: { from?: unknown; to?: unknown; aggregation?: unknown } }>(
    '/insights/v1/agents/:agentId/monthly-history',
    async (req, reply) => {
      const agent = await pathAgentFor(req, reply, resolveAgent, source.ownIdentityOnly); if (!agent) return;
      const { from, to, aggregation } = req.query;
      const range = checkMonthlyRange(from, to);
      if (!range.ok) return problem(reply, 400, 'INS-4000', 'Invalid parameter', range.detail);
      if (aggregation !== undefined && !isMonthlyAggregation(aggregation)) {
        return problem(reply, 400, 'INS-4000', 'Invalid parameter', `aggregation=${typeof aggregation === 'string' ? aggregation.slice(0, 24) : 'invalid'}`);
      }
      try {
        return await source.monthlyHistory(agent, { from: from as string, to: to as string, ...(aggregation !== undefined ? { aggregation } : {}) });
      } catch (e) {
        if ((e as { sourceCause?: string })?.sourceCause) return problem(reply, 503, 'INS-5030', withCause('Monthly history source unavailable', e));
        throw e;
      }
    },
  );

  app.get<{ Params: { agentId: string }; Querystring: { scope?: string; variant?: string } }>(
    '/insights/v1/agents/:agentId/milestones',
    async (req, reply) => {
      const c = await caller(req, reply); if (!c) return;
      let target: AgentRecord | undefined;
      try { target = await resolveAgent(req.params.agentId); } catch (e) { return problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); }
      if (!target) return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
      // Milestones are personal, scope-invariant (AC-P4-01-12/-20, OQ-10).
      return source.milestones(c.agent);
    },
  );

  app.get('/insights/v1/metric-definitions', async (req, reply) => {
    const c = await caller(req, reply); if (!c) return;
    return { country: c.agent.tenant, items: CATALOG };
  });

  app.get<{ Params: { agentId: string }; Querystring: { scope?: string; basis?: string } }>(
    '/insights/v1/agents/:agentId/metric-preferences',
    async (req, reply) => {
      const c = await caller(req, reply); if (!c) return;
      let agent: AgentRecord | undefined;
      try { agent = await resolveAgent(req.params.agentId); } catch (e) { return problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); }
      if (!agent) return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
      const scope = (req.query.scope ?? 'SELF') as Scope;
      const basis = (req.query.basis ?? 'STANDARD') as Basis;
      if (!SCOPES.has(scope)) return problem(reply, 400, 'INS-4000', 'Invalid parameter', `scope=${scope}`);
      return source.getPreferences(agent, scope, basis);
    },
  );

  app.put<{ Params: { agentId: string }; Querystring: { scope?: string; basis?: string }; Body: { priorityMetricCodes?: unknown; focusMetricCodes?: unknown } }>(
    '/insights/v1/agents/:agentId/metric-preferences',
    async (req, reply) => {
      const c = await caller(req, reply); if (!c) return;
      let agent: AgentRecord | undefined;
      try { agent = await resolveAgent(req.params.agentId); } catch (e) { return problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); }
      if (!agent) return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
      const scope = (req.query.scope ?? 'SELF') as Scope;
      const basis = (req.query.basis ?? 'STANDARD') as Basis;
      const body = req.body ?? {};
      const p = body.priorityMetricCodes; const f = body.focusMetricCodes;
      const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
      if (!isStrArr(p) || !isStrArr(f)) {
        return problem(reply, 400, 'INS-4001', 'priorityMetricCodes and focusMetricCodes must be string arrays');
      }
      const res = await source.putPreferences(agent, scope, basis, { priorityMetricCodes: p, focusMetricCodes: f });
      if (!res.ok) return problem(reply, 422, res.error.code, 'Preference validation failed', res.error.detail);
      return res.prefs;
    },
  );

  app.get<{ Params: { agentId: string }; Querystring: { scope?: string; context?: string } }>(
    '/insights/v1/agents/:agentId/recommendations',
    async (req, reply) => {
      const c = await caller(req, reply); if (!c) return;
      let agent: AgentRecord | undefined;
      try { agent = await resolveAgent(req.params.agentId); } catch (e) { return problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); }
      if (!agent) return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
      const scope = (req.query.scope ?? 'SELF') as Scope;
      return source.recommendations(agent, scope);
    },
  );

  app.post<{ Params: { agentId: string; recommendationId: string }; Body: { rating?: unknown } }>(
    '/insights/v1/agents/:agentId/recommendations/:recommendationId/feedback',
    async (req, reply) => {
      const c = await caller(req, reply); if (!c) return;
      let agent: AgentRecord | undefined;
      try { agent = await resolveAgent(req.params.agentId); } catch (e) { return problem(reply, 503, 'INS-5030', withCause('Identity source unavailable', e)); }
      if (!agent) return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
      const rating = req.body?.rating;
      if (rating !== 'UP' && rating !== 'DOWN') {
        return problem(reply, 400, 'INS-4002', 'rating must be UP or DOWN');
      }
      const ok = await source.recordFeedback(agent, req.params.recommendationId, rating);
      if (!ok) return problem(reply, 404, 'INS-4042', 'Unknown recommendation');
      return reply.status(204).send();
    },
  );

  // Convenience (not in the OpenAPI): expose the effective catalog per lens for debugging.
  app.get<{ Querystring: { scope?: string; basis?: string } }>('/insights/v1/debug/effective-catalog', async (req) => {
    const scope = (req.query.scope ?? 'SELF') as Scope;
    const basis = (req.query.basis ?? 'STANDARD') as Basis;
    return { scope, basis, items: effectiveCatalog(scope, basis).map((d) => ({ metricCode: d.metricCode, effCategory: d.effCategory, effOrder: d.effOrder, effSelected: d.effSelected })) };
  });

  // asOfDate sanity endpoint used by the smoke script.
  app.get('/insights/v1/debug/context', async () => contextFor({ period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' }));

  return app;
}
