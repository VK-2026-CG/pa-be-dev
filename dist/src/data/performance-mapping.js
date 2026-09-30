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
    PERSISTENCY_CY: persistency('currentYearPersistency'),
    PERSISTENCY_Y1: persistency('firstYearPersistency'), PERSISTENCY_Y2: persistency('secondYearPersistency'),
};
/** Same field names across both databases and all three collections. `type` (agentType) genuinely
 * varies per agent ('PAMB' vs also-Takaful-licensed 'HYBRID' in PAMB, always 'Takaful' in PBTB), but
 * isn't used for businessLine filtering yet — see the interim note on `entityFor` in performance-source.ts. */
export const PERFORMANCE_SOURCE_KEYS = {
    my_production: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
    my_mapa: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
    my_persistency: { identity: 'agentId', aggregation: 'agentAggregation', status: 'agentStatus', type: 'agentType', caseStatus: 'caseStatus' },
};
/**
 * SPEC-2026-002 0.4.0-draft: temporary widening — accept both spellings while an
 * upstream data-correction is in progress (owned by the requester). Revisit once
 * that correction lands and the permanent value(s) are confirmed.
 */
export const PERFORMANCE_ACTIVE_STATUS_VALUES = ['Active', 'A'];
export function performanceMetricPath(mapping, period, alternate = false) {
    if (!mapping.periods.includes(period))
        return undefined;
    return (alternate ? mapping.alternatePath : mapping.path)?.replace('{period}', period.toLowerCase());
}
