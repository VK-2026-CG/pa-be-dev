const RECO_ID = 'reco-2026-07-13-0206';
const feedbackStore = new Map();
export function recordFeedback(agentId, recommendationId, rating) {
    if (recommendationId !== RECO_ID)
        return false;
    feedbackStore.set(`${agentId}:${recommendationId}`, rating);
    return true;
}
export function recommendations(agentId, scope) {
    const rating = feedbackStore.get(`${agentId}:${RECO_ID}`);
    return {
        items: [
            { id: 'r1', type: 'PERFORMANCE', title: 'Review TPC run-rate', priority: 1, cta: { route: 'insights/metric-detail' } },
        ],
        panel: {
            recommendationId: RECO_ID,
            flags: [
                { code: 'PERFORMANCE_DROPS', severity: 'CRITICAL' },
                { code: 'HISTORIC_PACE_EXCEEDED', severity: 'INFO' },
            ],
            highlight: {
                metricCode: 'TPC',
                achieved: { kind: 'MONEY', amount: '152000.00', currency: 'MYR' },
                goal: { state: 'SET', target: { kind: 'MONEY', amount: '200000.00', currency: 'MYR' }, progressPct: 76 },
                runRateDeltaPct: 8,
            },
            insights: [
                {
                    code: 'acs-up-5', titleCode: 'AVERAGE_CASE_SIZE_MOVER', metricCode: 'AVERAGE_CASE_SIZE',
                    trend: { direction: 'UP', sentiment: 'POSITIVE', text: '5 spots this month' },
                    cta: { route: 'insights/metric-detail' },
                },
                {
                    code: 'anom-tpc-80', titleCode: 'CRITICAL_ANOMALIES',
                    trend: { direction: 'UP', sentiment: 'NEGATIVE', text: '5 spots this month' },
                    narrative: scope === 'TEAM'
                        ? '4 agents in your unit have hit critical performance drops this week, logging an 80% drop in TPC.'
                        : 'Your TPC pace dipped 12% below plan in the last two weeks; three pending cases would close the gap.',
                },
            ],
            cta: { route: 'insights/team-drilldown' },
            generatedAt: '2026-07-13T02:06:00Z',
            ...(rating ? { feedback: { rating } } : {}),
        },
        generatedAt: '2026-07-13T02:06:00Z',
    };
}
