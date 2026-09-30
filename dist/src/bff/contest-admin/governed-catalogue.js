const numericOperators = ['GTE', 'GT', 'LTE', 'LT', 'EQ', 'NEQ', 'BETWEEN'];
const lovOperators = ['EQ', 'NEQ', 'IN', 'NOT_IN', 'EXISTS'];
const booleanOperators = ['EQ', 'NEQ', 'EXISTS'];
const metric = (code, kind, operators, extra = {}) => ({ code, labelKey: `contest.catalogue.metric.${code}`, status: 'ACTIVE', kind, operators, ...extra });
const lov = (key, codes) => ({ key, version: 1, effectiveFrom: '2026-01-01', values: codes.map((code) => ({ code, labelKey: `contest.catalogue.${key}.${code}`, status: 'ACTIVE' })) });
export const governedContestCatalogue = {
    version: 'MY-2026.2',
    metrics: [
        ...['TPC', 'PTPC', 'FYP', 'FYC', 'ANNUAL_INCOME', 'RISK_INCOME', 'VNA_TPC', 'APE'].map((code) => metric(code, 'MONEY', numericOperators, { currency: 'MYR' })),
        ...['CASE_COUNT', 'PWYP_CASE_COUNT', 'VNA_COUNT', 'MDRT_MEMBER_COUNT', 'DIRECT_UNIT_QUALIFIER_COUNT', 'NEW_ACCOUNT_COUNT', 'PREMIER_CONSECUTIVE_YEARS', 'CONTRACT_TENURE_MONTHS'].map((code) => metric(code, 'COUNT', numericOperators)),
        ...['IPR', 'CURRENT_IPR', 'BASE_PRODUCT_SHARE'].map((code) => metric(code, 'PERCENT', numericOperators)),
        ...['UGQP', 'PQP'].map((code) => metric(code, 'DECIMAL', numericOperators)),
        ...['IS_ROOKIE', 'IS_VALIDATED_NEW_AGENT', 'IS_REGISTERED_MDRT', 'SUMMIT_QUALIFIED', 'DIRECT_OR_GROUP_QUALIFIED', 'IS_CONTRACTED', 'IS_REJOINED_AGENT', 'IS_IMMEDIATE_FAMILY', 'IS_FIRST_TIME_QUALIFIER'].map((code) => metric(code, 'BOOLEAN', booleanOperators)),
        ...['CONTRACT_DATE', 'CAPTURE_DATE', 'SUBMISSION_DATE', 'REGISTRATION_DATE', 'BUSINESS_DATE'].map((code) => metric(code, 'DATE', numericOperators)),
        metric('AGENT_LEVEL', 'DECIMAL', lovOperators, { operandLovKey: 'agent.level' }),
        metric('AUDIENCE_TYPE', 'DECIMAL', lovOperators, { operandLovKey: 'qualifier.type' }),
        metric('BUSINESS_LINE', 'DECIMAL', lovOperators, { operandLovKey: 'business.line' }),
        metric('PRODUCT_FAMILY', 'DECIMAL', lovOperators, { operandLovKey: 'product.family' }),
        metric('PRODUCT_CODE', 'DECIMAL', lovOperators, { operandLovKey: 'product.code' }),
        metric('RIDER_CODE', 'DECIMAL', lovOperators, { operandLovKey: 'rider.code' }),
        metric('PREMIUM_TYPE', 'DECIMAL', lovOperators, { operandLovKey: 'premium.type' }),
        metric('TRANSACTION_TYPE', 'DECIMAL', lovOperators, { operandLovKey: 'transaction.type' }),
        metric('BUSINESS_TYPE', 'DECIMAL', lovOperators, { operandLovKey: 'business.type' }),
        metric('REPRICING_TREATMENT', 'DECIMAL', lovOperators, { operandLovKey: 'production.repricing' }),
        metric('SOURCE_QUALIFICATION', 'DECIMAL', lovOperators, { operandLovKey: 'source.qualification' }),
        metric('REGION', 'DECIMAL', lovOperators, { operandLovKey: 'contest.region' }),
        metric('PAYMENT_TERM_YEARS', 'COUNT', numericOperators),
    ],
    lovs: [
        lov('agent.level', ['AGENT', 'UM1', 'UM2', 'AM', 'SAM']),
        lov('qualifier.type', ['PERSONAL', 'DIRECT_UNIT', 'GROUP', 'ROOKIE', 'INTRODUCER', 'VALIDATED_NEW_AGENT']),
        lov('business.line', ['INSURANCE', 'TAKAFUL']),
        lov('production.repricing', ['INCLUDING_REPRICING', 'EXCLUDING_REPRICING', 'NOT_APPLICABLE']),
        lov('product.family', ['CONVENTIONAL_LIFE', 'FAMILY_TAKAFUL', 'INDIVIDUAL_LIFE', 'INDIVIDUAL_CERTIFICATE', 'GROUP_LIFE', 'GROUP_TAKAFUL', 'UNIT_TRUST', 'PSA', 'SINGLE_PREMIUM', 'REGULAR_PREMIUM', 'GROUP_BUSINESS', 'GROUP_RENEWAL']),
        lov('product.code', ['PRUALLOCATOR', 'PRUBSN_ANUGERAH_MEDICALLOCATOR', 'PRUBSN_ASPIRASI', 'PRUBSN_WARISANGOLD_ALLOCATOR', 'PRULIVE_WELL', 'PRUWITH_YOU', 'PRUWITH_YOU_PLUS', 'PRULADY', 'PRUCANCER_X', 'PRUMAN']),
        lov('rider.code', ['PRUMILLION_MED_ACTIVE', 'ACTIVE_BOOSTER', 'PRUMILLION_MED_2', 'PRUMILLION_MED_BOOSTER_2', 'PRUVALUE_MED', 'PRUVALUE_MED_BOOSTER', 'PRUHEALTH', 'PRUMEDIC_OVERSEAS', 'TOTAL_MULTI_CRISIS_CARE', 'ESSENTIAL_CHILD_PLUS', 'MULTI_CRISIS_CARE', 'EARLY_CRISIS_CARE', 'CRISIS_CARE', 'CRISIS_GUARD', 'ESSENTIAL_CANCER_CARE', 'CRITICAL_CARE', 'CRITICAL_CARE_PLUS']),
        lov('premium.type', ['REGULAR_PREMIUM', 'SINGLE_PREMIUM', 'PSA', 'CONTRIBUTION', 'GROUP_PREMIUM', 'GROUP_CONTRIBUTION']),
        lov('transaction.type', ['NEW_BUSINESS', 'ENDORSEMENT', 'RENEWAL', 'REPRICING', 'CANCELLATION_FROM_INCEPTION', 'LAPSE', 'PREMIUM_REDUCTION', 'CONTRIBUTION_REDUCTION', 'RIDER_REMOVAL']),
        lov('business.type', ['INDIVIDUAL', 'GROUP', 'GROUP_NEW_BUSINESS', 'GROUP_RENEWAL']),
        lov('source.qualification', ['MDRT', 'COT', 'TOT', 'PRUDENTIAL_WEALTH_PLANNER', 'EXECUTIVE_WEALTH_PLANNER', 'SENIOR_WEALTH_PLANNER', 'PREMIER_WEALTH_PLANNER', 'MASTER_WEALTH_PLANNER', 'PRUMDA_GROUP', 'PRUMDA_DIRECT', 'STAR_CLUB', 'STAR_CLUB_SUMMIT']),
        lov('contest.region', ['CENTRAL_EAST_COAST', 'NORTHERN', 'SOUTHERN', 'EAST_MALAYSIA']),
    ],
};
