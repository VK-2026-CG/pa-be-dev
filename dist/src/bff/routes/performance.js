import { composeDashboard } from '../compose/dashboard.js';
import { composeCustomize } from '../compose/customize.js';
import { composeMetricDetail } from '../compose/metric-detail.js';
import { composeHistory } from '../compose/history.js';
import { buildMeta } from '../compose/shared.js';
import { CONFIG } from '../config.js';
import { isLeader } from '../persona.js';
import { getPersona as resolvePersona, mapDomainError, parseLens, problem } from '../bff.js';
function scopeOf(req) {
    return (req.query.scope ?? 'SELF');
}
function cardFromSnapshot(snap, filters) {
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
export function registerPerformanceRoutes(app, domain, source) {
    const getPersona = (request) => resolvePersona(request, source);
    app.get('/api/bff/v1/performance/dashboard', async (req, reply) => {
        const persona = getPersona(req);
        const lens = parseLens(req.query, persona, reply);
        if (!lens)
            return;
        try {
            return await composeDashboard(domain, persona, lens);
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.get('/api/bff/v1/performance/customize', async (req, reply) => {
        const persona = getPersona(req);
        const scope = scopeOf(req);
        if (scope === 'TEAM' && !isLeader(persona))
            return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
        try {
            return await composeCustomize(domain, persona, scope);
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.put('/api/bff/v1/performance/customize', async (req, reply) => {
        const persona = getPersona(req);
        const scope = scopeOf(req);
        if (scope === 'TEAM' && !isLeader(persona))
            return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
        const body = req.body;
        if (!body || typeof body !== 'object')
            return problem(reply, 400, 'BFF-4001', 'Body must be JSON');
        try {
            await domain.putPreferences(persona.agentId, persona.agentId, scope, body);
            return await composeCustomize(domain, persona, scope);
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.get('/api/bff/v1/performance/metrics/:metricCode', async (req, reply) => {
        const persona = getPersona(req);
        const lens = parseLens(req.query, persona, reply);
        if (!lens)
            return;
        try {
            return await composeMetricDetail(domain, persona, req.params.metricCode, lens);
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.get('/api/bff/v1/performance/metrics/:metricCode/history', async (req, reply) => {
        const persona = getPersona(req);
        const lens = parseLens(req.query, persona, reply);
        if (!lens)
            return;
        const window = (req.query.window ?? CONFIG.screens.history.defaultWindow);
        if (!CONFIG.screens.history.windows.includes(window)) {
            return problem(reply, 400, 'BFF-4000', 'Invalid window', window);
        }
        try {
            return await composeHistory(domain, persona, req.params.metricCode, lens, window);
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.post('/api/bff/v1/performance/recommendations/:recommendationId/feedback', async (req, reply) => {
        const persona = getPersona(req);
        const rating = req.body?.rating;
        if (rating !== 'UP' && rating !== 'DOWN')
            return problem(reply, 400, 'BFF-4002', 'rating must be UP or DOWN');
        try {
            await domain.feedback(persona.agentId, persona.agentId, req.params.recommendationId, rating);
            return reply.status(204).send();
        }
        catch (e) {
            return mapDomainError(reply, e);
        }
    });
    app.get('/api/bff/v1/performance/team-drilldown', async (req, reply) => {
        const persona = getPersona(req);
        if (!isLeader(persona))
            return problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona');
        const teamView = (req.query.teamView ?? 'DIRECT');
        if (teamView !== 'DIRECT' && teamView !== 'GROUP')
            return problem(reply, 400, 'BFF-4000', 'Invalid teamView', String(req.query.teamView));
        if (teamView === 'GROUP' && persona.level !== 'P2') {
            return problem(reply, 403, 'BFF-4031', 'teamView=GROUP requires a P2-level leader');
        }
        const hierarchyBasis = (req.query.basis ?? 'AGENT');
        if (hierarchyBasis !== 'AGENT' && hierarchyBasis !== 'AM' && hierarchyBasis !== 'UM') {
            return problem(reply, 400, 'BFF-4000', 'Invalid basis', String(req.query.basis));
        }
        const period = (req.query.period ?? 'YTD');
        if (period !== 'MTD' && period !== 'QTD' && period !== 'YTD') {
            return problem(reply, 400, 'BFF-4000', 'Invalid period', String(req.query.period));
        }
        const businessLine = (req.query.businessLine ?? 'ALL');
        if (businessLine !== 'ALL' && businessLine !== 'INSURANCE' && businessLine !== 'TAKAFUL') {
            return problem(reply, 400, 'BFF-4000', 'Invalid businessLine', String(req.query.businessLine));
        }
        const performanceBasis = (req.query.performanceBasis ?? req.query.metricBasis ?? 'STANDARD');
        if (performanceBasis !== 'STANDARD' && performanceBasis !== 'SCHEME') {
            return problem(reply, 400, 'BFF-4000', 'Invalid performanceBasis', String(req.query.performanceBasis ?? req.query.metricBasis));
        }
        const search = req.query.query?.trim() || undefined;
        const selectedAgentId = req.query.selectedAgentId?.trim() || undefined;
        try {
            const members = await domain.listTeamMembers(persona.agentId, persona.agentId, {
                teamView,
                basis: hierarchyBasis,
                query: search,
            });
            let selectedMember;
            if (selectedAgentId) {
                const dashboard = await domain.getTeamMemberDashboard(persona.agentId, persona.agentId, selectedAgentId, {
                    teamView,
                    basis: hierarchyBasis,
                    period,
                    businessLine,
                    performanceBasis,
                });
                selectedMember = {
                    member: dashboard.member,
                    context: {
                        period: dashboard.context.period.type,
                        businessLine: dashboard.context.businessLine,
                        basis: dashboard.context.basis,
                        scope: 'TEAM',
                        teamView,
                        asOfDate: dashboard.context.asOfDate,
                    },
                    metrics: dashboard.metrics.map((m) => cardFromSnapshot(m, {
                        period,
                        businessLine,
                        basis: performanceBasis,
                        teamView,
                    })),
                };
            }
            const asOfDate = selectedMember?.context.asOfDate ?? members.asOfDate;
            return {
                meta: buildMeta('S-P4-07', asOfDate),
                filters: {
                    scope: 'TEAM',
                    teamView,
                    basis: hierarchyBasis,
                    ...(search ? { search } : {}),
                },
                members: members.items,
                ...(selectedMember ? { selectedMember } : {}),
            };
        }
        catch (e) {
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
    app.get('/api/bff/v1/compensation', async (req) => {
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
