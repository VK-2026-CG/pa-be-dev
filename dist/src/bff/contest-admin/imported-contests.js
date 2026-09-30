import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contestAdminConfig } from './config.js';
import { governedContestCatalogue } from './governed-catalogue.js';
const BUILDER_FIXTURE_PATH = fileURLToPath(new URL('../../../vendor/spec/contest-admin-fixtures/builder.json', import.meta.url));
const baseFixture = JSON.parse(readFileSync(BUILDER_FIXTURE_PATH, 'utf8'));
const base = structuredClone(baseFixture);
const citation = (circularCode, issuedAt, page, section, status = 'ACTIVE', supersededBy) => ({
    citationId: `${circularCode}:p${page}:${section.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
    circularCode, issuedAt, page, section, status, ...(supersededBy ? { supersededBy } : {}),
});
const ref = (circular, page, section) => `${circular}:p${page}:${section.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`;
const threshold = (metricCode, value, sourceCitationIds, periodId = 'FULL', operator = 'GTE', qualifierCode) => ({ metricCode, operator, value, periodId, sourceCitationIds, ...(qualifierCode ? { qualifierCode } : {}), ...(typeof value === 'string' && ['TPC', 'PTPC', 'FYP', 'FYC', 'ANNUAL_INCOME', 'APE', 'VNA_TPC'].includes(metricCode) ? { currency: 'MYR' } : {}) });
const option = (optionCode, allOf, sourceCitationIds) => ({ optionCode, allOf, sourceCitationIds });
const award = (ruleId, labelKey, audienceCode, rankCodes, options, rewardCodes, sourceCitationIds, extra = {}) => ({ ruleId, labelKey, audienceCode, rankCodes, options, rewardCodes, sourceCitationIds, ...extra });
const credit = (ruleId, metricCode, productCode, rate, sourceCitationIds, extra = {}) => ({ ruleId, metricCode, productCode, rate, include: true, sourceCitationIds, ...extra });
const tracking = (ruleId, type, effectiveTo, actionCode, sourceCitationIds) => ({ ruleId, type, effectiveTo, actionCode, sourceCitationIds });
const nodeToken = (value) => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
const lovPredicate = (nodeId, metricCode, valueCodes, sourceCitationIds, operator = 'IN') => ({ nodeId, type: 'PREDICATE', metricCode, operator, operand: { kind: 'LOV_SET', lovKey: governedContestCatalogue.metrics.find(metric => metric.code === metricCode).operandLovKey, valueCodes }, sourceCitationIds });
function thresholdPredicate(ruleId, optionCode, index, item) {
    let metricCode = item.metricCode;
    let operand;
    let operator = item.operator;
    if (metricCode.endsWith('_WEALTH_PLANNER')) {
        operand = { kind: 'LOV', lovKey: 'source.qualification', valueCode: metricCode };
        metricCode = 'SOURCE_QUALIFICATION';
        operator = 'EQ';
    }
    else {
        const metric = governedContestCatalogue.metrics.find(candidate => candidate.code === metricCode);
        if (metric?.kind === 'BOOLEAN') {
            operand = { kind: 'BOOLEAN', value: Boolean(item.value) };
            operator = 'EQ';
        }
        else if (metric?.kind === 'COUNT')
            operand = { kind: 'INTEGER', value: Number(item.value) };
        else if (metric?.kind === 'PERCENT')
            operand = { kind: 'PERCENT', value: String(item.value) };
        else if (metric?.kind === 'DECIMAL')
            operand = { kind: 'DECIMAL', value: String(item.value) };
        else
            operand = { kind: 'MONEY', value: String(item.value), currency: item.currency ?? 'MYR' };
    }
    const repricingCode = optionCode.includes('EXCLUDE') ? 'EXCLUDING_REPRICING' : optionCode.includes('INCLUDE') ? 'INCLUDING_REPRICING' : undefined;
    return { nodeId: `${ruleId}_${nodeToken(optionCode)}_${index}`, type: 'PREDICATE', metricCode, operator, operand, context: { periodId: item.periodId, ...(repricingCode ? { repricingCode } : {}) }, sourceCitationIds: item.sourceCitationIds };
}
function productConditions(circularCode, rule) {
    const refs = rule.sourceCitationIds;
    const isUnitTrust = rule.ruleId.includes('unit_trust');
    const insuranceOnly = ['ACC2026_20', 'ACC2026_21a', 'ACC2026_26'].includes(circularCode) && !isUnitTrust;
    const conditions = [];
    if (insuranceOnly)
        conditions.push(lovPredicate(`${rule.ruleId}_insurance_only`, 'BUSINESS_LINE', ['INSURANCE'], refs, 'IN'));
    if (isUnitTrust)
        conditions.push(lovPredicate(`${rule.ruleId}_unit_trust_only`, 'PRODUCT_FAMILY', ['UNIT_TRUST'], refs, 'IN'));
    if (rule.ruleId.includes('group_business'))
        conditions.push(lovPredicate(`${rule.ruleId}_group_business`, 'BUSINESS_TYPE', ['GROUP'], refs, 'IN'));
    if (circularCode === 'ACC2026_05') {
        conditions.push(lovPredicate(`${rule.ruleId}_included_products`, 'PRODUCT_FAMILY', ['CONVENTIONAL_LIFE', 'FAMILY_TAKAFUL', 'SINGLE_PREMIUM', 'PSA', 'GROUP_BUSINESS'], refs, 'IN'));
        conditions.push({ nodeId: `${rule.ruleId}_exclude_products`, type: 'NOT', child: lovPredicate(`${rule.ruleId}_excluded_product_family`, 'PRODUCT_FAMILY', ['UNIT_TRUST', 'GROUP_RENEWAL'], refs, 'IN') });
    }
    if (circularCode === 'ACC2026_10a' && rule.audienceCode === 'ROOKIE')
        conditions.push({ nodeId: `${rule.ruleId}_exclude_rookie_products`, type: 'NOT', child: lovPredicate(`${rule.ruleId}_rookie_excluded_products`, 'PRODUCT_FAMILY', ['UNIT_TRUST', 'GROUP_BUSINESS'], refs, 'IN') });
    if (circularCode === 'ACC2026_21a' && rule.ruleId.includes('health')) {
        conditions.push(lovPredicate(`${rule.ruleId}_health_products`, 'PRODUCT_CODE', ['PRUWITH_YOU', 'PRUWITH_YOU_PLUS'], refs, 'IN'));
        conditions.push(lovPredicate(`${rule.ruleId}_health_riders`, 'RIDER_CODE', governedContestCatalogue.lovs.find(item => item.key === 'rider.code').values.map(value => value.code), refs, 'IN'));
    }
    if (circularCode === 'ACC2026_26') {
        conditions.push(lovPredicate(`${rule.ruleId}_transactions`, 'TRANSACTION_TYPE', ['NEW_BUSINESS', 'ENDORSEMENT'], refs, 'IN'));
        conditions.push({ nodeId: `${rule.ruleId}_excluded_products`, type: 'NOT', child: lovPredicate(`${rule.ruleId}_excluded_product_families`, 'PRODUCT_FAMILY', ['UNIT_TRUST', 'GROUP_BUSINESS'], refs, 'IN') });
        conditions.push(lovPredicate(`${rule.ruleId}_repricing`, 'REPRICING_TREATMENT', ['EXCLUDING_REPRICING'], refs, 'IN'));
    }
    return conditions;
}
function compileAwardExpression(circularCode, rule) {
    const refs = rule.sourceCitationIds;
    const methods = rule.options.map(option => {
        const conditions = option.allOf.map((item, index) => thresholdPredicate(rule.ruleId, option.optionCode, index, item));
        if (circularCode === 'ACC2026_26' && option.optionCode.includes('CASES')) {
            conditions.unshift(lovPredicate(`${rule.ruleId}_${nodeToken(option.optionCode)}_pwyp_product`, 'PRODUCT_CODE', ['PRUWITH_YOU_PLUS'], refs, 'IN'));
            conditions.unshift(lovPredicate(`${rule.ruleId}_${nodeToken(option.optionCode)}_pwyp_rider`, 'RIDER_CODE', governedContestCatalogue.lovs.find(item => item.key === 'rider.code').values.map(value => value.code), refs, 'IN'));
        }
        return { nodeId: `${rule.ruleId}_${nodeToken(option.optionCode)}_all`, type: 'ALL', children: conditions };
    });
    const nonEmptyMethods = methods.filter(method => method.children.length > 0);
    const qualification = nonEmptyMethods.length === 0 ? undefined : nonEmptyMethods.length === 1 ? nonEmptyMethods[0] : { nodeId: `${rule.ruleId}_alternatives`, type: 'ANY', minimumPass: 1, children: nonEmptyMethods };
    return { nodeId: `${rule.ruleId}_root`, type: 'ALL', children: [
            lovPredicate(`${rule.ruleId}_audience`, 'AUDIENCE_TYPE', [rule.audienceCode], refs, 'IN'),
            lovPredicate(`${rule.ruleId}_ranks`, 'AGENT_LEVEL', rule.rankCodes, refs, 'IN'),
            ...productConditions(circularCode, rule),
            ...(qualification ? [qualification] : []),
        ] };
}
function makeBuilder(args) {
    const contestId = `contest_${args.slug}`, versionId = `version_${args.slug}_v1`;
    const tiers = args.imported.awardRules.map((item, index) => ({ tierId: item.ruleId, code: item.ruleId.toUpperCase(), labelKey: item.labelKey, order: index + 1, rewardCode: item.rewardCodes.join('+') }));
    const periods = args.imported.periods.map((item, index) => ({ periodId: item.periodId, labelKey: item.labelKey, order: index + 1 }));
    const targets = args.imported.awardRules.flatMap(item => args.imported.periods.map(period => {
        const target = item.options.flatMap(candidate => candidate.allOf).find(candidate => candidate.periodId === period.periodId && ['TPC', 'PTPC', 'FYP', 'FYC', 'ANNUAL_INCOME', 'APE', 'CASE_COUNT', 'PWYP_CASE_COUNT', 'VNA_COUNT'].includes(candidate.metricCode));
        return { tierId: item.ruleId, periodId: period.periodId, state: target ? 'EXPLICIT' : 'NOT_APPLICABLE', ...(target ? { value: String(target.value) } : {}) };
    }));
    const catalogue = structuredClone(governedContestCatalogue);
    return {
        ...structuredClone(base),
        contest: { contestId, code: args.code, nameKey: args.nameKey, status: 'DRAFT', ownerRef: 'contest_ops_my', campaignStart: args.start, campaignEnd: args.end, audienceCodes: args.audiences, ruleCount: args.imported.awardRules.length, updatedAt: args.updatedAt, nav: { route: `/contest-admin/contests/${contestId}/versions/${versionId}/edit/BASICS` } },
        versionId, revision: 1, etag: '"revision-1"', readOnly: false, activeStep: 'BASICS', catalogue,
        steps: contestAdminConfig.builder.stepOrder.map(stepCode => ({ stepCode, status: 'VALID', issueCount: 0, nav: { route: `/contest-admin/contests/${contestId}/versions/${versionId}/edit/${stepCode}` } })),
        configuration: {
            basics: { timezone: 'Asia/Kuala_Lumpur', sourceCircular: args.imported.effectiveCircularCode },
            audience: { rules: args.imported.audienceRules },
            qualification: { routes: args.imported.awardRules.map((item, index) => ({ routeId: item.ruleId, code: item.ruleId.toUpperCase(), labelKey: item.labelKey, order: index + 1, enabled: true, audienceCode: item.audienceCode, expression: compileAwardExpression(args.imported.effectiveCircularCode, item), tierIds: [item.ruleId], selectionPolicy: item.topN ? { mode: 'TOP_N', topN: item.topN, rankByMetricCode: item.rankByMetricCode, rankDirection: 'DESC', tieBreakers: item.tieBreakMetricCode ? [{ order: 1, metricCode: item.tieBreakMetricCode, direction: 'DESC' }] : [] } : { mode: 'ALL_QUALIFIERS' }, rewardPolicy: { rewardCodes: item.rewardCodes, precedenceCode: (item.precedenceCode ?? 'HIGHEST_ELIGIBLE') }, trackingPolicyIds: args.imported.trackingRules.map(policy => policy.ruleId), sourceCitationIds: item.sourceCitationIds })), tiers, periods, targets, rewardPrecedenceCode: 'HIGHEST_ELIGIBLE' },
            calculation: { metricCode: args.imported.creditRules[0]?.metricCode ?? 'TPC', creditRate: '100.00', roundingCode: 'HALF_UP_2', creditRules: args.imported.creditRules },
            rewards: { precedenceCode: 'HIGHEST_ELIGIBLE', awardRules: args.imported.awardRules },
            governance: { frequencyCode: 'DAILY', executionTime: '07:00', approvalRouteCode: 'BUSINESS_DATA', trackingRules: args.imported.trackingRules },
            provenance: { effectiveCircularCode: args.imported.effectiveCircularCode, citations: args.imported.citations },
            importedCircular: args.imported,
        },
        validation: { score: 100, blocking: false, issues: [] }, autosave: { state: 'SAVED', savedAt: args.updatedAt },
    };
}
const fullPeriod = (labelKey = 'contest.period.FULL') => [{ periodId: 'FULL', labelKey, from: '2026-01-01', to: '2026-12-31' }];
const commonExclusions = (sourceCitationIds) => [
    { code: 'FRAUD_MANIPULATION', labelKey: 'contest.exclusion.fraud', sourceCitationIds },
    { code: 'CONTRACT_TERMINATED', labelKey: 'contest.exclusion.terminated', sourceCitationIds },
];
const wealthCircular = 'ACC2026_05';
const wealthReq = ref(wealthCircular, 2, 'C Requirements');
const wealthCalc = ref(wealthCircular, 3, 'D Production Credit');
const wealth = makeBuilder({ slug: 'wealth_planner_2026', code: 'ACC2026_05', nameKey: 'contest.imported.wealthPlanner', start: '2026-01-01', end: '2026-12-31', audiences: ['PERSONAL'], updatedAt: '2026-01-13T00:00:00Z', imported: {
        sourceName: 'ACC2026_05_2026 Prudential Wealth Planner.pdf', effectiveCircularCode: wealthCircular,
        citations: [citation(wealthCircular, '2026-01-13', 2, 'C Requirements'), citation(wealthCircular, '2026-01-13', 3, 'D Production Credit'), citation(wealthCircular, '2026-01-13', 3, 'E Persistency')], periods: fullPeriod(),
        audienceRules: [{ audienceCode: 'PERSONAL', rankCodes: ['AGENT', 'UM1', 'UM2'], include: true, entityCodes: ['PAMB', 'PRUBSN_DIRECT'], sourceCitationIds: [wealthReq] }, { audienceCode: 'PERSONAL', rankCodes: ['AM', 'SAM'], include: false, sourceCitationIds: [wealthReq] }, { audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-12-31', sourceCitationIds: [wealthReq] }],
        awardRules: [
            award('wealth_planner', 'contest.award.wealthPlanner', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('TPC', [threshold('TPC', '125000.00', [wealthReq])], [wealthReq])], ['LAPEL_PIN', 'ISSOSNE'], [wealthReq]),
            award('executive_wealth', 'contest.award.executiveWealth', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('TPC_IPR', [threshold('TPC', '250000.00', [wealthReq]), threshold('IPR', '85.00', [wealthReq])], [wealthReq])], ['LAPEL_PIN', 'NAAP', 'ISSOSNE'], [wealthReq]),
            award('senior_wealth', 'contest.award.seniorWealth', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('TPC_IPR', [threshold('TPC', '375000.00', [wealthReq]), threshold('IPR', '85.00', [wealthReq])], [wealthReq])], ['DIGITAL', 'LAPEL_PIN', 'NAAP', 'ISSOSNE'], [wealthReq]),
            award('premier_wealth', 'contest.award.premierWealth', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('TPC_IPR', [threshold('TPC', '500000.00', [wealthReq]), threshold('IPR', '85.00', [wealthReq])], [wealthReq])], ['DIGITAL', 'TROPHY', 'LAPEL_PIN', 'NAAP', 'ISSOSNE'], [wealthReq]),
            award('master_wealth', 'contest.award.masterWealth', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('FIVE_CONSECUTIVE', [threshold('PREMIER_CONSECUTIVE_YEARS', 5, [wealthReq])], [wealthReq])], ['DIGITAL', 'BLAZER_FIRST_TIME', 'TROPHY', 'LAPEL_PIN', 'NAAP', 'ISSOSNE'], [wealthReq]),
        ],
        creditRules: [credit('regular', 'TPC', 'REGULAR_LIFE_TAKAFUL', '100.00', [wealthCalc]), credit('single', 'TPC', 'SINGLE_PREMIUM', '10.00', [wealthCalc], { capPctOfMetric: '25.00' }), credit('psa', 'TPC', 'PSA', '10.00', [wealthCalc], { capPctOfMetric: '25.00' }), credit('group_new', 'TPC', 'GROUP_NEW_BUSINESS', '100.00', [wealthCalc], { capPctOfMetric: '25.00' }), credit('unit_trust', 'TPC', 'UNIT_TRUST', '0.00', [wealthCalc], { include: false })],
        trackingRules: [tracking('issosne-tenure', 'CONTRACT_STATUS', '2027-06-30', 'REQUIRE_24_MONTH_TENURE', [wealthReq]), tracking('issosne-tpc', 'PRODUCTION', '2027-06-30', 'REQUIRE_100000_TPC', [wealthReq])], exclusions: commonExclusions([wealthReq]), reviewState: 'VERIFIED',
    } });
const mdrtCircular = 'ACC2026_07';
const mdrtReq = ref(mdrtCircular, 2, 'C Requirements');
const mdrtSponsor = ref(mdrtCircular, 3, 'C Sponsorship');
const mdrtCalc = ref(mdrtCircular, 3, 'FYP Production Credit');
const mdrtThresholds = { MDRT: ['398400.00', '132800.00', '230100.00'], COT: ['1195200.00', '398400.00', '690300.00'], TOT: ['2390400.00', '796800.00', '1380600.00'] };
const mdrt = makeBuilder({ slug: 'mdrt_2027', code: 'ACC2026_07', nameKey: 'contest.imported.mdrt', start: '2026-01-01', end: '2026-12-31', audiences: ['PERSONAL'], updatedAt: '2026-01-13T00:00:00Z', imported: {
        sourceName: 'ACC2026_07_2027 MDRT Series.pdf', effectiveCircularCode: mdrtCircular, citations: [citation(mdrtCircular, '2026-01-13', 2, 'C Requirements'), citation(mdrtCircular, '2026-01-13', 3, 'C Sponsorship'), citation(mdrtCircular, '2026-01-13', 3, 'FYP Production Credit'), citation(mdrtCircular, '2026-01-13', 4, 'D Production Credit')], periods: fullPeriod(),
        audienceRules: [{ audienceCode: 'PERSONAL', rankCodes: ['AGENT', 'UM1', 'UM2', 'AM', 'SAM'], include: true, entityCodes: ['PAMB', 'PRUBSN_DIRECT'], sourceCitationIds: [mdrtReq] }, { audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-12-31', sourceCitationIds: [mdrtSponsor] }],
        awardRules: ['MDRT', 'COT', 'TOT'].map((tier) => { const values = mdrtThresholds[tier]; return award(`mdrt_${tier.toLowerCase()}`, `contest.award.${tier.toLowerCase()}`, 'PERSONAL', ['AGENT', 'UM1', 'UM2', 'AM', 'SAM'], [option('FYP', [threshold('FYP', values[0], [mdrtReq])], [mdrtReq]), option('FYC', [threshold('FYC', values[1], [mdrtReq])], [mdrtReq]), option('INCOME', [threshold('ANNUAL_INCOME', values[2], [mdrtReq]), threshold('RISK_INCOME', '66200.00', [mdrtReq])], [mdrtReq])], [`${tier}_PIN`, `${tier}_PLAQUE`, 'DIGITAL', 'EVENT_RECOGNITION'], [mdrtReq], { precedenceCode: 'HIGHEST_ONLY' }); }),
        creditRules: [credit('fyp_regular', 'FYP', 'REGULAR_LIFE_TAKAFUL', '100.00', [mdrtCalc]), credit('fyp_single', 'FYP', 'SINGLE_PREMIUM', '6.00', [mdrtCalc]), credit('fyp_group', 'FYP', 'GROUP_LIFE_TAKAFUL', '10.00', [mdrtCalc]), credit('fyp_unit_trust', 'FYP', 'UNIT_TRUST', '6.00', [mdrtCalc], { minimumSharePct: '50.00' }), credit('tpc_regular', 'TPC', 'REGULAR_LIFE_TAKAFUL', '100.00', [ref(mdrtCircular, 4, 'D Production Credit')]), credit('tpc_credit', 'TPC', 'SINGLE_PREMIUM_PSA', '10.00', [ref(mdrtCircular, 4, 'D Production Credit')], { capPctOfMetric: '25.00' })],
        trackingRules: [tracking('registration', 'REGISTRATION', '2027-02-28', 'REQUIRE_REGISTERED_MDRT', [mdrtSponsor]), tracking('sponsorship-rookie', 'PRODUCTION', '2026-12-31', 'ROOKIE_TPC_240K_INCL_OR_200K_EXCL_REPRICING', [mdrtSponsor]), tracking('sponsorship-standard', 'PRODUCTION', '2026-12-31', 'TPC_340K_INCL_OR_280K_EXCL_REPRICING', [mdrtSponsor]), tracking('psa-clawback', 'CLAWBACK', '2027-02-28', 'CLAWBACK_MEMBERSHIP_FEE_IF_PSA_TRACKING_FAILS', [mdrtCalc])], exclusions: commonExclusions([mdrtReq]), reviewState: 'VERIFIED',
    } });
const starCircular = 'ACC2026_10a';
const starPersonal = ref(starCircular, 2, 'C Personal');
const starDirect = ref(starCircular, 3, 'C Direct Unit');
const starGroup = ref(starCircular, 4, 'C Group');
const starTrack = ref(starCircular, 8, 'Production Tracking');
const starAwards = [];
for (const [audience, ranks, source, values, ipr] of [
    ['PERSONAL', ['AGENT', 'UM1', 'UM2'], starPersonal, [['900000.00', '1080000.00'], ['560000.00', '680000.00'], ['450000.00', '540000.00'], ['280000.00', '340000.00']], '85.00'],
    ['DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], starDirect, [['4500000.00', '5400000.00'], ['2800000.00', '3400000.00'], ['2250000.00', '2700000.00'], ['1400000.00', '1700000.00']], '85.00'],
    ['GROUP', ['AM', 'SAM'], starGroup, [['6300000.00', '7560000.00'], ['3920000.00', '4760000.00'], ['3150000.00', '3780000.00'], ['1960000.00', '2380000.00']], '80.00'],
]) {
    values.forEach((pair, index) => starAwards.push(award(`star_${audience.toLowerCase()}_${index + 1}`, `contest.award.starTier${index + 1}`, audience, [...ranks], [option('EXCLUDE_REPRICING', [threshold('TPC', pair[0], [source]), ...(audience === 'PERSONAL' ? [threshold('CASE_COUNT', 30, [source])] : []), threshold('IPR', ipr, [source])], [source]), option('INCLUDE_REPRICING', [threshold('TPC', pair[1], [source]), ...(audience === 'PERSONAL' ? [threshold('CASE_COUNT', 30, [source])] : []), threshold('IPR', ipr, [source])], [source])], [index === 0 ? 'SUMMIT_2' : index === 1 ? 'STAR_2' : index === 2 ? 'SUMMIT_1' : 'STAR_1'], [source], { precedenceCode: 'HIGHEST_ONLY' })));
}
starAwards.push(award('star_rookie', 'contest.award.starRookie', 'ROOKIE', ['AGENT'], [option('EXCLUDE_REPRICING', [threshold('TPC', '200000.00', [starPersonal]), threshold('CURRENT_IPR', '90.00', [starPersonal])], [starPersonal]), option('INCLUDE_REPRICING', [threshold('TPC', '240000.00', [starPersonal]), threshold('CURRENT_IPR', '90.00', [starPersonal])], [starPersonal])], ['STAR_1'], [starPersonal]));
starAwards.push(award('star_top_producer', 'contest.award.starTopProducer', 'PERSONAL', ['AGENT'], [option('SUMMIT_QUALIFIER', [threshold('SUMMIT_QUALIFIED', 1, [starDirect])], [starDirect])], ['SPECIAL_RECOGNITION', 'ROOM_UPGRADE'], [starDirect], { topN: 10, rankByMetricCode: 'TPC', tieBreakMetricCode: 'CASE_COUNT' }));
starAwards.push(award('star_am_extra', 'contest.award.starAmExtra', 'PERSONAL', ['AM', 'SAM'], [option('EXTRA', [threshold('DIRECT_OR_GROUP_QUALIFIED', 1, [starGroup]), threshold('TPC', '450000.00', [starGroup]), threshold('CASE_COUNT', 30, [starGroup]), threshold('IPR', '85.00', [starGroup])], [starGroup])], ['SUMMIT_1'], [starGroup], { precedenceCode: 'MAX_ONE_EXTRA' }));
const star = makeBuilder({ slug: 'star_club_2026', code: 'ACC2026_10a', nameKey: 'contest.imported.starClub', start: '2026-01-01', end: '2026-12-31', audiences: ['PERSONAL', 'DIRECT_UNIT', 'GROUP'], updatedAt: '2026-02-04T00:00:00Z', imported: {
        sourceName: 'ACC2026_10a_2026 Star Club Series.pdf', effectiveCircularCode: starCircular, citations: [citation(starCircular, '2026-02-04', 2, 'C Personal'), citation(starCircular, '2026-02-04', 3, 'C Direct Unit'), citation(starCircular, '2026-02-04', 4, 'C Group'), citation(starCircular, '2026-02-04', 5, 'January Credit'), citation(starCircular, '2026-02-04', 8, 'Production Tracking')], periods: fullPeriod(),
        audienceRules: [{ audienceCode: 'PERSONAL', rankCodes: ['AGENT', 'UM1', 'UM2'], include: true, entityCodes: ['PAMB', 'PRUBSN_DIRECT'], sourceCitationIds: [starPersonal] }, { audienceCode: 'DIRECT_UNIT', rankCodes: ['UM1', 'UM2', 'AM', 'SAM'], include: true, sourceCitationIds: [starDirect] }, { audienceCode: 'GROUP', rankCodes: ['AM', 'SAM'], include: true, sourceCitationIds: [starGroup] }, { audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-12-31', sourceCitationIds: [starPersonal] }], awardRules: starAwards,
        creditRules: [credit('regular', 'TPC', 'REGULAR_LIFE_TAKAFUL', '100.00', [starPersonal]), credit('single_psa', 'TPC', 'SINGLE_PREMIUM_PSA', '10.00', [starPersonal], { capPctOfMetric: '25.00' }), credit('january_personal', 'TPC', 'JANUARY_EXCL_REPRICING', '50.00', [ref(starCircular, 5, 'January Credit')]), credit('unit_trust', 'TPC', 'UNIT_TRUST', '0.00', [starPersonal], { include: false })],
        trackingRules: [tracking('case-substitution', 'PRODUCTION', '2026-12-31', 'EACH_CASE_SHORTFALL_REQUIRES_10000_TPC', [starPersonal]), tracking('production', 'PRODUCTION', '2027-02-28', 'REVISE_TIER_FOR_LAPSE_CANCEL_REDUCTION', [starTrack]), tracking('persistency', 'PERSISTENCY', '2027-02-28', 'REQUIRE_PREMIUMS_COLLECTED', [starTrack])], exclusions: commonExclusions([starTrack]), reviewState: 'VERIFIED',
    } });
const topCircular = 'ACC2026_20';
const topLeader = ref(topCircular, 2, 'C Agency Leaders');
const topRecruit = ref(topCircular, 3, 'C Recruitment MDRT');
const topAgent = ref(topCircular, 4, 'C Agents');
const topSpecial = ref(topCircular, 5, 'C Group Unit Trust');
const ranked = (id, key, audience, ranks, value, ipr, topN, source, metric = 'TPC', tie = 'CASE_COUNT') => award(id, key, audience, ranks, [option('MINIMUM', [threshold(metric, value, [source]), ...(ipr ? [threshold('IPR', ipr, [source])] : [])], [source])], ['TROPHY_PLAQUE', 'DIGITAL', 'NAAP'], [source], { topN, rankByMetricCode: metric, tieBreakMetricCode: tie });
const topAwards = [
    ranked('top_group_rookie_am', 'contest.award.topRookieAm', 'GROUP', ['AM'], '3000000.00', '80.00', 1, topLeader), ranked('top_group_emerging', 'contest.award.topEmerging', 'GROUP', ['AM'], '5000000.00', '80.00', 1, topLeader), ranked('top_group_am', 'contest.award.topAgencyManagers', 'GROUP', ['AM', 'SAM'], '10000000.00', '80.00', 3, topLeader),
    ranked('top_du_rookie_am', 'contest.award.topRookieAm', 'DIRECT_UNIT', ['AM'], '1000000.00', '85.00', 1, topLeader), ranked('top_du_emerging_am', 'contest.award.topEmerging', 'DIRECT_UNIT', ['AM'], '3000000.00', '85.00', 1, topLeader), ranked('top_du_am', 'contest.award.topAgencyManagers', 'DIRECT_UNIT', ['AM', 'SAM'], '5000000.00', '85.00', 3, topLeader), ranked('top_du_rookie_um', 'contest.award.topRookieUm', 'DIRECT_UNIT', ['UM1'], '1000000.00', '85.00', 1, topLeader), ranked('top_du_emerging_um', 'contest.award.topEmerging', 'DIRECT_UNIT', ['UM1', 'UM2'], '2000000.00', '85.00', 1, topLeader), ranked('top_du_um', 'contest.award.topUnitManagers', 'DIRECT_UNIT', ['UM1', 'UM2'], '3000000.00', '85.00', 3, topLeader),
    award('top_recruiters', 'contest.award.topRecruiters', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('VNA', [threshold('VNA_COUNT', 3, [topRecruit]), threshold('VNA_TPC', '25000.00', [topRecruit]), threshold('CURRENT_IPR', '90.00', [topRecruit])], [topRecruit])], ['TROPHY_PLAQUE', 'DIGITAL', 'NAAP'], [topRecruit], { topN: 5, rankByMetricCode: 'VNA_COUNT', tieBreakMetricCode: 'VNA_TPC' }),
    award('top_mdrt_builders', 'contest.award.topMdrtBuilders', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('MDRT', [threshold('MDRT_MEMBER_COUNT', 5, [topRecruit])], [topRecruit])], ['TROPHY_PLAQUE', 'DIGITAL', 'NAAP'], [topRecruit], { topN: 5, rankByMetricCode: 'MDRT_MEMBER_COUNT', tieBreakMetricCode: 'TPC' }),
    ranked('top_agents', 'contest.award.topAgents', 'PERSONAL', ['AGENT'], '500000.00', '85.00', 10, topAgent), ranked('top_rookie_agents', 'contest.award.topRookieAgents', 'ROOKIE', ['AGENT'], '300000.00', '90.00', 5, topAgent),
    ranked('top_group_business_leader', 'contest.award.topGroupBusinessLeader', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], '250000.00', '', 1, topSpecial, 'APE', 'NEW_ACCOUNT_COUNT'), ranked('top_group_business_agents', 'contest.award.topGroupBusinessAgents', 'PERSONAL', ['AGENT'], '125000.00', '', 3, topSpecial, 'APE', 'NEW_ACCOUNT_COUNT'),
    award('top_unit_trust_leader', 'contest.award.topUnitTrustLeader', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('RANK', [], [topSpecial])], ['TROPHY_PLAQUE', 'DIGITAL', 'NAAP'], [topSpecial], { topN: 1, rankByMetricCode: 'UGQP', tieBreakMetricCode: 'NEW_ACCOUNT_COUNT' }), award('top_unit_trust_agents', 'contest.award.topUnitTrustAgents', 'PERSONAL', ['AGENT'], [option('RANK', [], [topSpecial])], ['TROPHY_PLAQUE', 'DIGITAL', 'NAAP'], [topSpecial], { topN: 3, rankByMetricCode: 'PQP', tieBreakMetricCode: 'NEW_ACCOUNT_COUNT' }),
    ...[['master', 'MASTER_WEALTH_PLANNER'], ['premier', 'PREMIER_WEALTH_PLANNER'], ['senior', 'SENIOR_WEALTH_PLANNER'], ['executive', 'EXECUTIVE_WEALTH_PLANNER']].map(([id, qualifier]) => award(`top_wealth_${id}`, `contest.award.${id}Wealth`, 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('CROSS_QUALIFICATION', [threshold(qualifier, 1, [topAgent])], [topAgent])], ['NAAP_INVITATION'], [topAgent])),
];
const top = makeBuilder({ slug: 'top_achievers_2026', code: 'ACC2026_20', nameKey: 'contest.imported.topAchievers', start: '2026-01-01', end: '2026-12-31', audiences: ['PERSONAL', 'DIRECT_UNIT', 'GROUP'], updatedAt: '2026-04-16T00:00:00Z', imported: { sourceName: 'ACC2026_20_2026 Top Achievers.pdf', effectiveCircularCode: topCircular, citations: [citation(topCircular, '2026-04-16', 2, 'C Agency Leaders'), citation(topCircular, '2026-04-16', 3, 'C Recruitment MDRT'), citation(topCircular, '2026-04-16', 4, 'C Agents'), citation(topCircular, '2026-04-16', 5, 'C Group Unit Trust'), citation(topCircular, '2026-04-16', 8, 'D Production Credit')], periods: fullPeriod(), audienceRules: [{ audienceCode: 'PERSONAL', rankCodes: ['AGENT'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [topAgent] }, { audienceCode: 'DIRECT_UNIT', rankCodes: ['UM1', 'UM2', 'AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [topLeader] }, { audienceCode: 'GROUP', rankCodes: ['AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [topLeader] }, { audienceCode: 'EMERGING', rankCodes: ['UM1', 'UM2', 'AM'], include: true, maxAge: 35, sourceCitationIds: [topLeader] }, { audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-12-31', sourceCitationIds: [topAgent] }], awardRules: topAwards, creditRules: [credit('life', 'TPC', 'CONVENTIONAL_LIFE', '100.00', [ref(topCircular, 8, 'D Production Credit')]), credit('single_psa', 'TPC', 'SINGLE_PREMIUM_PSA', '10.00', [ref(topCircular, 8, 'D Production Credit')], { capPctOfMetric: '25.00' }), credit('unit_group', 'TPC', 'UNIT_TRUST_GROUP', '0.00', [ref(topCircular, 8, 'D Production Credit')], { include: false })], trackingRules: [tracking('submission', 'SUBMISSION_CUTOFF', '2026-12-24', 'REJECT_LATE_SUBMISSION', [topSpecial]), tracking('vna-contract', 'CONTRACT_STATUS', '2027-01-31', 'VNA_MUST_REMAIN_CONTRACTED', [topRecruit]), tracking('mdrt-register', 'REGISTRATION', '2027-02-28', 'REQUIRE_REGISTERED_MDRT', [topRecruit])], exclusions: [...commonExclusions([topSpecial]), { code: 'OWN_FAMILY_Q4', labelKey: 'contest.exclusion.ownFamilyQ4', sourceCitationIds: [topSpecial] }, { code: 'REJOINED_RECRUITMENT', labelKey: 'contest.exclusion.rejoinedRecruitment', sourceCitationIds: [topRecruit] }], reviewState: 'VERIFIED' } });
const raapCircular = 'ACC2026_21a';
const raapLeader = ref(raapCircular, 2, 'C Agency Leaders');
const raapRecruit = ref(raapCircular, 3, 'C Recruitment PRUMDA');
const raapAgent = ref(raapCircular, 4, 'C Agents');
const raapAwards = [
    ranked('raap_group_am', 'contest.award.topAgencyManagers', 'GROUP', ['AM', 'SAM'], '1000000.00', '80.00', 3, raapLeader), ranked('raap_group_health', 'contest.award.topHealthAgencyManagers', 'GROUP', ['AM', 'SAM'], '1000000.00', '80.00', 3, raapLeader), ranked('raap_du_am', 'contest.award.topAgencyManagers', 'DIRECT_UNIT', ['AM', 'SAM'], '500000.00', '85.00', 3, raapLeader), ranked('raap_du_um', 'contest.award.topUnitManagers', 'DIRECT_UNIT', ['UM1', 'UM2'], '500000.00', '85.00', 3, raapLeader), ranked('raap_du_health_um', 'contest.award.topHealthUnitManagers', 'DIRECT_UNIT', ['UM1', 'UM2'], '500000.00', '85.00', 3, raapLeader),
    award('raap_group_recruiters', 'contest.award.topRecruiters', 'GROUP', ['AM', 'SAM'], [option('VNA', [threshold('VNA_COUNT', 2, [raapRecruit]), threshold('VNA_TPC', '25000.00', [raapRecruit]), threshold('CURRENT_IPR', '90.00', [raapRecruit])], [raapRecruit])], ['TROPHY_PLAQUE', 'DIGITAL', 'RAAP'], [raapRecruit], { topN: 3, rankByMetricCode: 'VNA_COUNT', tieBreakMetricCode: 'VNA_TPC' }),
    award('raap_du_recruiters', 'contest.award.topRecruiters', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('VNA', [threshold('VNA_COUNT', 2, [raapRecruit]), threshold('VNA_TPC', '25000.00', [raapRecruit]), threshold('CURRENT_IPR', '90.00', [raapRecruit])], [raapRecruit])], ['TROPHY_PLAQUE', 'DIGITAL', 'RAAP'], [raapRecruit], { topN: 3, rankByMetricCode: 'VNA_COUNT', tieBreakMetricCode: 'VNA_TPC' }),
    ranked('raap_rookie', 'contest.award.topRookieAgents', 'ROOKIE', ['AGENT'], '125000.00', '90.00', 3, raapAgent), ranked('raap_wealth', 'contest.award.topWealthPlanners', 'PERSONAL', ['AGENT'], '250000.00', '85.00', 10, raapAgent), ranked('raap_health', 'contest.award.topHealthAgents', 'PERSONAL', ['AGENT'], '125000.00', '85.00', 3, raapAgent),
    award('raap_mdrt', 'contest.award.mdrt', 'PERSONAL', ['AGENT', 'UM1', 'UM2', 'AM', 'SAM'], [option('NON_ROOKIE_INCL', [threshold('TPC', '340000.00', [raapAgent])], [raapAgent]), option('NON_ROOKIE_EXCL', [threshold('TPC', '280000.00', [raapAgent])], [raapAgent]), option('ROOKIE_INCL', [threshold('TPC', '240000.00', [raapAgent])], [raapAgent]), option('ROOKIE_EXCL', [threshold('TPC', '200000.00', [raapAgent])], [raapAgent])], ['RAAP_INVITATION'], [raapAgent]),
    award('raap_wealth_planner', 'contest.award.wealthPlanner', 'PERSONAL', ['AGENT', 'UM1', 'UM2'], [option('TPC_IPR', [threshold('TPC', '125000.00', [raapAgent]), threshold('IPR', '85.00', [raapAgent])], [raapAgent])], ['RAAP_INVITATION'], [raapAgent]),
    award('raap_prumda_group', 'contest.award.prumdaGroup', 'GROUP', ['AM', 'SAM'], [option('TPC_IPR', [threshold('TPC', '2000000.00', [raapRecruit]), threshold('IPR', '80.00', [raapRecruit])], [raapRecruit])], ['PRUMDA_RECOGNITION'], [raapRecruit]),
    award('raap_prumda_direct', 'contest.award.prumdaDirect', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('TPC_IPR', [threshold('TPC', '1000000.00', [raapRecruit]), threshold('IPR', '85.00', [raapRecruit])], [raapRecruit])], ['PRUMDA_RECOGNITION'], [raapRecruit]),
];
const raap = makeBuilder({ slug: 'raap_2026', code: 'ACC2026_21a', nameKey: 'contest.imported.raap', start: '2026-01-01', end: '2026-12-31', audiences: ['PERSONAL', 'DIRECT_UNIT', 'GROUP'], updatedAt: '2026-06-03T00:00:00Z', imported: { sourceName: 'ACC2026_21a_2026 RAAP.pdf', effectiveCircularCode: raapCircular, citations: [citation('ACC2026_21', '2026-04-16', 2, 'C Requirements', 'SUPERSEDED', raapCircular), citation(raapCircular, '2026-06-03', 2, 'C Agency Leaders'), citation(raapCircular, '2026-06-03', 3, 'C Recruitment PRUMDA'), citation(raapCircular, '2026-06-03', 4, 'C Agents'), citation(raapCircular, '2026-06-03', 5, 'D Further Requirements'), citation(raapCircular, '2026-06-03', 7, 'D Production Credit')], periods: fullPeriod(), audienceRules: [{ audienceCode: 'PERSONAL', rankCodes: ['AGENT'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [raapAgent] }, { audienceCode: 'DIRECT_UNIT', rankCodes: ['UM1', 'UM2', 'AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [raapLeader] }, { audienceCode: 'GROUP', rankCodes: ['AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [raapLeader] }, { audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-12-31', sourceCitationIds: [raapAgent] }], awardRules: raapAwards, creditRules: [credit('life', 'TPC', 'CONVENTIONAL_LIFE', '100.00', [ref(raapCircular, 7, 'D Production Credit')]), credit('single_psa', 'TPC', 'SINGLE_PREMIUM_PSA', '10.00', [ref(raapCircular, 7, 'D Production Credit')], { capPctOfMetric: '25.00' }), credit('takaful', 'TPC', 'TAKAFUL', '0.00', [raapLeader], { include: false })], trackingRules: [tracking('submission', 'SUBMISSION_CUTOFF', '2026-12-24', 'REJECT_LATE_SUBMISSION', [ref(raapCircular, 5, 'D Further Requirements')]), tracking('vna-contract', 'CONTRACT_STATUS', '2027-01-31', 'VNA_MUST_REMAIN_CONTRACTED', [raapRecruit])], exclusions: [...commonExclusions([raapLeader]), { code: 'OWN_FAMILY_Q4', labelKey: 'contest.exclusion.ownFamilyQ4', sourceCitationIds: [ref(raapCircular, 5, 'D Further Requirements')] }, { code: 'REJOINED_RECRUITMENT', labelKey: 'contest.exclusion.rejoinedRecruitment', sourceCitationIds: [raapRecruit] }], reviewState: 'VERIFIED' } });
const ynCircular = 'ACC2026_26';
const ynReq = ref(ynCircular, 2, 'C Requirements');
const ynCalc = ref(ynCircular, 3, 'D Production Credit');
const yunnan = makeBuilder({ slug: 'race_yunnan_2026', code: 'ACC2026_26', nameKey: 'contest.imported.yunnan', start: '2026-07-01', end: '2026-11-30', audiences: ['PERSONAL', 'DIRECT_UNIT'], updatedAt: '2026-07-03T00:00:00Z', imported: { sourceName: 'ACC2026_26_Race To YunNan.pdf', effectiveCircularCode: ynCircular, citations: [citation(ynCircular, '2026-07-03', 2, 'C Requirements'), citation(ynCircular, '2026-07-03', 3, 'D Production Credit'), citation(ynCircular, '2026-07-03', 3, 'E Case Count')], periods: [{ periodId: 'H1', labelKey: 'contest.period.JUL_SEP', from: '2026-07-01', to: '2026-09-30' }, { periodId: 'H2', labelKey: 'contest.period.OCT_NOV', from: '2026-10-01', to: '2026-11-30' }, { periodId: 'FULL', labelKey: 'contest.period.JUL_NOV', from: '2026-07-01', to: '2026-11-30' }], audienceRules: [{ audienceCode: 'ROOKIE', rankCodes: ['AGENT'], include: true, contractFrom: '2025-10-01', contractTo: '2026-11-30', entityCodes: ['PAMB'], sourceCitationIds: [ynReq] }, { audienceCode: 'PERSONAL', rankCodes: ['AGENT', 'UM1', 'UM2', 'AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [ynReq] }, { audienceCode: 'DIRECT_UNIT', rankCodes: ['UM1', 'UM2', 'AM', 'SAM'], include: true, entityCodes: ['PAMB'], sourceCitationIds: [ynReq] }], awardRules: [
            award('yunnan_rookie', 'contest.award.yunnanRookie', 'ROOKIE', ['AGENT'], [option('CASES', [threshold('PWYP_CASE_COUNT', 20, [ynReq], 'FULL')], [ynReq]), option('PTPC', [threshold('PTPC', '100000.00', [ynReq], 'FULL')], [ynReq])], ['YUNNAN_TICKET'], [ynReq], { precedenceCode: 'MAX_ONE' }),
            award('yunnan_personal', 'contest.award.yunnanPersonal', 'PERSONAL', ['AGENT', 'UM1', 'UM2', 'AM', 'SAM'], [option('SPLIT_CASES', [threshold('PWYP_CASE_COUNT', 15, [ynReq], 'H1'), threshold('PWYP_CASE_COUNT', 15, [ynReq], 'H2')], [ynReq]), option('FULL_CASES', [threshold('PWYP_CASE_COUNT', 36, [ynReq], 'FULL')], [ynReq]), option('SPLIT_PTPC', [threshold('PTPC', '60000.00', [ynReq], 'H1'), threshold('PTPC', '60000.00', [ynReq], 'H2')], [ynReq]), option('FULL_PTPC', [threshold('PTPC', '150000.00', [ynReq], 'FULL')], [ynReq])], ['YUNNAN_TICKET'], [ynReq], { precedenceCode: 'MAX_ONE' }),
            award('yunnan_direct', 'contest.award.yunnanDirect', 'DIRECT_UNIT', ['UM1', 'UM2', 'AM', 'SAM'], [option('SPLIT_CASES', [threshold('PWYP_CASE_COUNT', 75, [ynReq], 'H1'), threshold('PWYP_CASE_COUNT', 75, [ynReq], 'H2')], [ynReq]), option('FULL_CASES', [threshold('PWYP_CASE_COUNT', 180, [ynReq], 'FULL')], [ynReq]), option('SPLIT_PTPC', [threshold('PTPC', '300000.00', [ynReq], 'H1'), threshold('PTPC', '300000.00', [ynReq], 'H2')], [ynReq]), option('FULL_PTPC', [threshold('PTPC', '750000.00', [ynReq], 'FULL')], [ynReq]), option('QUALIFIERS', [threshold('DIRECT_UNIT_QUALIFIER_COUNT', 5, [ynReq], 'FULL')], [ynReq])], ['YUNNAN_TICKET'], [ynReq], { precedenceCode: 'MAX_ONE' }),
        ], creditRules: [credit('long_term', 'PTPC', 'PAYMENT_TERM_20_PLUS', '100.00', [ynCalc]), credit('short_term', 'PTPC', 'PAYMENT_TERM_UNDER_20', '50.00', [ynCalc]), credit('single_psa', 'PTPC', 'SINGLE_PREMIUM_PSA', '10.00', [ynCalc], { capPctOfMetric: '25.00' }), credit('unit_group', 'PTPC', 'UNIT_TRUST_GROUP', '0.00', [ynCalc], { include: false }), credit('prulivewell', 'PTPC', 'PRULIVE_WELL', '100.00', [ynCalc])], trackingRules: [tracking('capture', 'SUBMISSION_CUTOFF', '2026-11-30', 'CAPTURED_IN_PERIOD_EXCLUDE_REPRICING', [ynReq])], exclusions: [...commonExclusions([ynReq]), { code: 'TAKAFUL', labelKey: 'contest.exclusion.takaful', sourceCitationIds: [ynReq] }], reviewState: 'VERIFIED' } });
export const importedContestBuilders = [wealth, mdrt, star, top, raap, yunnan];
export function getImportedCircular(builder) { return builder.configuration.importedCircular; }
