const PERIODS = ['MTD', 'QTD', 'YTD'];
const production = (path, valueType = 'MONEY') => ({ collection: 'my_production', path: `ptd.${path}.{period}`, valueType, periods: PERIODS });
const mapa = (path, valueType) => ({ collection: 'my_mapa', path: `ptd.${path}.{period}`, valueType, periods: PERIODS });
const persistency = (path) => ({ collection: 'my_persistency', path: `metrics.ytd.${path}`, valueType: 'PERCENT', periods: ['YTD'], fraction: true });
/** SPEC-2026-002: explicit source paths, independent of any imported sample identity. */
export const PERFORMANCE_METRIC_MAPPING = {
    TPC: { ...production('tpc.withoutRepricing'), alternatePath: 'ptd.tpc.withRepricing.{period}' },
    PTPC: { ...production('ptpc.withoutRepricing'), alternatePath: 'ptd.ptpc.withRepricing.{period}' },
    FYP: production('fyp'), FYC: production('fyc'), CASE_COUNT: production('caseCount.total', 'COUNT'),
    MANPOWER: mapa('manpowerTotal', 'COUNT'), ACTIVITY_RATIO: mapa('activityRatio', 'PERCENT'),
    PRODUCTIVITY: mapa('productivity', 'DECIMAL'), AVERAGE_CASE_SIZE: mapa('averageCaseSize', 'MONEY'),
    NEW_RECRUIT_CONTRACTED: mapa('newRecruits', 'COUNT'),
    PERSISTENCY_CY: persistency('current_year_persistency'),
    PERSISTENCY_Y1: persistency('first_year_persistency'), PERSISTENCY_Y2: persistency('second_year_persistency'),
};
export const PERFORMANCE_SOURCE_KEYS = {
    my_production: { identity: 'agent_id', aggregation: 'agent_aggregation' },
    my_mapa: { identity: 'agentId', aggregation: 'agentAggregation' },
    my_persistency: { identity: 'agentId', aggregation: 'agentAggregation' },
};
export function performanceMetricPath(mapping, period, alternate = false) {
    if (!mapping.periods.includes(period))
        return undefined;
    return (alternate ? mapping.alternatePath : mapping.path)?.replace('{period}', period.toLowerCase());
}
