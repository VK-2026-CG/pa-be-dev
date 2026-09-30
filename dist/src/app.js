import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { findAgent } from './data/registry.js';
import { CATALOG, effectiveCatalog } from './data/catalog.js';
import { ANCHOR_YEAR, contextFor } from './data/values.js';
import { PerformanceSourceNotFound } from './data/performance-record.js';
import { SpecContestRepository } from './contest/spec-repository.js';
import { registerSpecContestRoutes } from './contest/spec-routes.js';
import { createContestBrochureStore } from './contest/brochure-store.js';
import { ContestBrochureImportService } from './contest/brochure-import.js';
import { createBrochureInferenceProvider } from './contest/brochure-import-provider.js';
import { registerBffRoutes } from './bff/index.js';
const PERIODS = new Set(['MTD', 'QTD', 'YTD']);
const BLS = new Set(['ALL', 'INSURANCE', 'TAKAFUL']);
const BASES = new Set(['STANDARD', 'SCHEME']);
const SCOPES = new Set(['SELF', 'TEAM']);
const TVS = new Set(['DIRECT', 'GROUP']);
function problem(reply, status, code, title, detail) {
    const body = { title, status, code, ...(detail ? { detail } : {}) };
    return reply.status(status).type('application/problem+json').send(body);
}
/** Stub auth: trusts x-agent-id / x-tenant headers (the BFF's stub JWT). */
function callerFor(req, reply, resolveAgent, ownIdentityOnly = false) {
    if (ownIdentityOnly && (!req.headers['x-agent-id'] || (req.headers['x-tenant'] && req.headers['x-tenant'] !== 'MY'))) {
        void problem(reply, 401, 'INS-4010', 'Development identity required');
        return null;
    }
    const agentId = req.headers['x-agent-id'] ?? 'A1001';
    const agent = resolveAgent(agentId);
    if (!agent) {
        void problem(reply, 401, 'INS-4010', 'Unknown caller identity');
        return null;
    }
    const target = req.params?.agentId;
    if (ownIdentityOnly && target && target !== agent.agentId) {
        void problem(reply, 403, 'INS-4030', 'Agent may only read own data');
        return null;
    }
    return { agent };
}
/** Parse + authorize the standard lens params. Returns null after replying on error. */
function lensFor(req, reply, resolveAgent, ownIdentityOnly = false) {
    const c = callerFor(req, reply, resolveAgent, ownIdentityOnly);
    if (!c)
        return null;
    const pathAgent = resolveAgent(req.params.agentId);
    if (!pathAgent) {
        void problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        return null;
    }
    if (pathAgent.agentId !== c.agent.agentId && c.agent.level === 'P4') {
        void problem(reply, 403, 'INS-4030', 'Agent may only read own data');
        return null;
    }
    const q = req.query;
    const period = (q.period ?? 'YTD');
    const businessLine = (q.businessLine ?? 'ALL');
    const basis = (q.basis ?? 'STANDARD');
    const scope = (q.scope ?? 'SELF');
    const teamView = (q.teamView ?? (scope === 'TEAM' ? 'DIRECT' : undefined));
    for (const [name, val, set] of [
        ['period', period, PERIODS], ['businessLine', businessLine, BLS], ['basis', basis, BASES], ['scope', scope, SCOPES],
    ]) {
        if (!set.has(val)) {
            void problem(reply, 400, 'INS-4000', 'Invalid parameter', `${name}=${val}`);
            return null;
        }
    }
    if (teamView !== undefined && !TVS.has(teamView)) {
        void problem(reply, 400, 'INS-4000', 'Invalid parameter', `teamView=${teamView}`);
        return null;
    }
    // Scope/level gating (D-14, ruling 2026-08): TEAM needs a leader; GROUP needs P2.
    if (scope === 'TEAM' && pathAgent.level === 'P4') {
        void problem(reply, 403, 'INS-4032', 'scope=TEAM requires a leader (P2/P3)');
        return null;
    }
    if (scope === 'TEAM' && teamView === 'GROUP' && pathAgent.level !== 'P2') {
        void problem(reply, 403, 'INS-4031', 'teamView=GROUP requires a P2-level leader');
        return null;
    }
    return { period, businessLine, basis, scope, ...(scope === 'TEAM' ? { teamView } : {}), agent: pathAgent };
}
export function buildApp(source, specContestRepository = new SpecContestRepository(), brochureStore = createContestBrochureStore(), inferenceProvider = createBrochureInferenceProvider()) {
    const resolveAgent = source.findAgent?.bind(source) ?? findAgent;
    const caller = (req, reply) => callerFor(req, reply, resolveAgent, source.ownIdentityOnly);
    const lens = (req, reply) => lensFor(req, reply, resolveAgent, source.ownIdentityOnly);
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof PerformanceSourceNotFound)
            return problem(reply, error.status, error.code, error.title);
        return reply.send(error); // Preserve Fastify's existing handling for other routes.
    });
    void app.register(cors, { origin: true });
    void app.register(multipart);
    app.get('/healthz', async () => ({ ok: true, service: 'pruaction-insights-service', spec: '1.4.0' }));
    registerSpecContestRoutes(app, specContestRepository, brochureStore, new ContestBrochureImportService(specContestRepository, brochureStore, inferenceProvider));
    registerBffRoutes(app, source);
    app.get('/insights/v1/agents/:agentId/metrics', async (req, reply) => {
        const l = lens(req, reply);
        if (!l)
            return;
        const raw = req.query;
        const listScope = (raw.listScope ?? 'ALL');
        const codes = raw.codes ? raw.codes.split(',') : undefined;
        const list = await source.metricList(l.agent, l, listScope, codes);
        if (!list)
            return problem(reply, 404, 'INS-4040', 'No data materialized for this lens');
        return list;
    });
    app.get('/insights/v1/agents/:agentId/metrics/:metricCode', async (req, reply) => {
        const l = lens(req, reply);
        if (!l)
            return;
        const detail = await source.metricDetail(l.agent, req.params.metricCode, l);
        if (!detail)
            return problem(reply, 404, 'INS-4041', 'Metric not in catalog for this lens', req.params.metricCode);
        return detail;
    });
    app.get('/insights/v1/agents/:agentId/metrics/:metricCode/series', async (req, reply) => {
        const l = lens(req, reply);
        if (!l)
            return;
        const anchorYear = req.query.anchorYear ? Number(req.query.anchorYear) : ANCHOR_YEAR;
        const yearsBack = req.query.yearsBack !== undefined ? Number(req.query.yearsBack) : 2;
        if (!Number.isInteger(yearsBack) || yearsBack < 0 || yearsBack > 4) {
            return problem(reply, 400, 'INS-4000', 'Invalid parameter', `yearsBack=${req.query.yearsBack}`);
        }
        const s = await source.metricSeries(l.agent, req.params.metricCode, l, anchorYear, yearsBack);
        if (!s)
            return problem(reply, 404, 'INS-4041', 'Metric has no history for this lens', req.params.metricCode);
        return s;
    });
    app.get('/insights/v1/agents/:agentId/milestones', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        if (!resolveAgent(req.params.agentId))
            return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        // Milestones are personal, scope-invariant (AC-P4-01-12/-20, OQ-10).
        return source.milestones(c.agent);
    });
    app.get('/insights/v1/metric-definitions', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        return { country: c.agent.tenant, items: CATALOG };
    });
    app.get('/insights/v1/agents/:agentId/metric-preferences', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        const agent = resolveAgent(req.params.agentId);
        if (!agent)
            return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        const scope = (req.query.scope ?? 'SELF');
        const basis = (req.query.basis ?? 'STANDARD');
        if (!SCOPES.has(scope))
            return problem(reply, 400, 'INS-4000', 'Invalid parameter', `scope=${scope}`);
        return source.getPreferences(agent, scope, basis);
    });
    app.put('/insights/v1/agents/:agentId/metric-preferences', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        const agent = resolveAgent(req.params.agentId);
        if (!agent)
            return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        const scope = (req.query.scope ?? 'SELF');
        const basis = (req.query.basis ?? 'STANDARD');
        const body = req.body ?? {};
        const p = body.priorityMetricCodes;
        const f = body.focusMetricCodes;
        const isStrArr = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
        if (!isStrArr(p) || !isStrArr(f)) {
            return problem(reply, 400, 'INS-4001', 'priorityMetricCodes and focusMetricCodes must be string arrays');
        }
        const res = await source.putPreferences(agent, scope, basis, { priorityMetricCodes: p, focusMetricCodes: f });
        if (!res.ok)
            return problem(reply, 422, res.error.code, 'Preference validation failed', res.error.detail);
        return res.prefs;
    });
    app.get('/insights/v1/agents/:agentId/recommendations', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        const agent = resolveAgent(req.params.agentId);
        if (!agent)
            return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        const scope = (req.query.scope ?? 'SELF');
        return source.recommendations(agent, scope);
    });
    app.post('/insights/v1/agents/:agentId/recommendations/:recommendationId/feedback', async (req, reply) => {
        const c = caller(req, reply);
        if (!c)
            return;
        const agent = resolveAgent(req.params.agentId);
        if (!agent)
            return problem(reply, 404, 'INS-4040', 'Unknown agent for tenant');
        const rating = req.body?.rating;
        if (rating !== 'UP' && rating !== 'DOWN') {
            return problem(reply, 400, 'INS-4002', 'rating must be UP or DOWN');
        }
        const ok = await source.recordFeedback(agent, req.params.recommendationId, rating);
        if (!ok)
            return problem(reply, 404, 'INS-4042', 'Unknown recommendation');
        return reply.status(204).send();
    });
    // Convenience (not in the OpenAPI): expose the effective catalog per lens for debugging.
    app.get('/insights/v1/debug/effective-catalog', async (req) => {
        const scope = (req.query.scope ?? 'SELF');
        const basis = (req.query.basis ?? 'STANDARD');
        return { scope, basis, items: effectiveCatalog(scope, basis).map((d) => ({ metricCode: d.metricCode, effCategory: d.effCategory, effOrder: d.effOrder, effSelected: d.effSelected })) };
    });
    // asOfDate sanity endpoint used by the smoke script.
    app.get('/insights/v1/debug/context', async () => contextFor({ period: 'YTD', businessLine: 'ALL', basis: 'STANDARD', scope: 'SELF' }));
    return app;
}
