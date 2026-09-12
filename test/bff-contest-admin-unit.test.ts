import { describe, it, expect } from 'vitest';
import { contestAdminConfig } from '../src/bff/contest-admin/config.js';
import { ContestStubError, getBuilder, getPortfolio, getRuleEditor, patchBuilder } from '../src/bff/contest-admin/stub-repository.js';
import { importedContestBuilders, getImportedCircular } from '../src/bff/contest-admin/imported-contests.js';
import type { RuleExpressionVM, RulePredicateVM } from '../vendor/spec/contest-admin-vm.js';
import { validateImportedContest } from '../src/bff/contest-admin/import-validation.js';

function nodes(expression: RuleExpressionVM): RuleExpressionVM[] { return [expression, ...(expression.type === 'PREDICATE' ? [] : expression.type === 'NOT' ? nodes(expression.child) : expression.children.flatMap(nodes))]; }
function predicates(expression: RuleExpressionVM): RulePredicateVM[] { return nodes(expression).filter((node): node is RulePredicateVM => node.type === 'PREDICATE'); }

describe('Contest Administration C3/C4 contracts', () => {
  it('(AC-CA-02-01) config owns all seven deep-linkable builder steps', () => {
    expect(contestAdminConfig.builder.stepOrder).toEqual(['BASICS', 'AUDIENCE', 'QUALIFICATION', 'CALCULATION', 'REWARDS', 'GOVERNANCE', 'REVIEW']);
    expect(contestAdminConfig.routes).toHaveLength(10);
    expect(contestAdminConfig.routes).toContainEqual({ code: 'CONTEST_IMPORT', route: '/contest-admin/contest-imports/:importId', enabled: true });
    expect(contestAdminConfig.capabilities.aiBrochureDraftImport).toBe(true);
  });

  it('(AC-CA-01-03) portfolio metrics are independent from visible rows', () => {
    const result = getPortfolio(new URLSearchParams('query=not-present'));
    expect(result.contests).toHaveLength(0);
    expect(result.metrics.find((metric) => metric.code === 'TOTAL_CONTESTS')?.value).toBe(6);
  });

  it('(AC-CA-02-02) PATCH requires current ETag and preserves server draft on conflict', () => {
    const before = getBuilder('contest_ca0001', 'version_ca0001');
    expect(() => patchBuilder('contest_ca0001', 'version_ca0001', '"stale"', { basics: { timezone: 'UTC' } })).toThrow(ContestStubError);
    expect(getBuilder('contest_ca0001', 'version_ca0001').configuration).toEqual(before.configuration);
    const saved = patchBuilder('contest_ca0001', 'version_ca0001', before.etag, { basics: { timezone: 'Asia/Kuala_Lumpur' } });
    expect(saved.revision).toBe(before.revision + 1);
  });

  it('(AC-CA-02-04) step status comes from validation state, not route visits', () => {
    const builder = getBuilder('contest_ca0001', 'version_ca0001');
    expect(builder.steps.find((step) => step.stepCode === 'AUDIENCE')?.status).toBe('IN_PROGRESS');
    expect(builder.steps.find((step) => step.stepCode === 'REWARDS')?.status).toBe('NOT_STARTED');
  });

  it('(AC-CA-02-05, AC-CA-03-01) fixture carries canonical nested routes and decimal-string tier targets', () => {
    const builder = getBuilder('contest_ca0001', 'version_ca0001');
    const qualification = builder.configuration.qualification!;
    expect(qualification.routes[0]?.expression.type).toBe('ALL');
    const root = qualification.routes[0]?.expression;
    expect(root && root.type === 'ALL' ? root.children[0] : undefined).toMatchObject({ type: 'ANY', minimumPass: 1 });
    expect(qualification.targets.filter((cell) => cell.state === 'EXPLICIT').every((cell) => typeof cell.value === 'string')).toBeTruthy();
    expect(qualification.targets.some((cell) => cell.state === 'NOT_APPLICABLE' && cell.value === undefined)).toBeTruthy();
  });

  it('(AC-CA-03-02) governed metric catalogue constrains operators and LOV operands', () => {
    const catalogue = getBuilder('contest_ca0001', 'version_ca0001').catalogue;
    expect(catalogue.metrics.find((metric) => metric.code === 'AGENT_LEVEL')).toMatchObject({ operandLovKey: 'agent.level', operators: ['EQ', 'NEQ', 'IN', 'NOT_IN', 'EXISTS'] });
    expect(catalogue.lovs.find((lov) => lov.key === 'agent.level')?.values.map((value) => value.code)).toContain('SAM');
  });

  it('(AC-CA-IMPORT-01) configures six circular-backed contests with complete citations and decimal-string money', () => {
    expect(importedContestBuilders.map((item) => item.contest.code)).toEqual(['ACC2026_05', 'ACC2026_07', 'ACC2026_10a', 'ACC2026_20', 'ACC2026_21a', 'ACC2026_26']);
    for (const item of importedContestBuilders) {
      const imported = getImportedCircular(item)!;
      expect(imported.reviewState).toBe('VERIFIED');
      expect(imported.citations.length).toBeGreaterThan(0);
      expect(imported.awardRules.every((rule) => rule.sourceCitationIds.length > 0 && rule.options.every((option) => option.sourceCitationIds.length > 0))).toBeTruthy();
      const money = imported.awardRules.flatMap((rule) => rule.options.flatMap((option) => option.allOf)).filter((value) => value.currency === 'MYR');
      expect(money.every((value) => typeof value.value === 'string' && /^\d+\.\d{2}$/.test(value.value))).toBeTruthy();
    }
  });

  it('(AC-CA-IMPORT-LOV-01) every imported metric, period, citation and LOV value resolves against the governed catalogue', () => {
    for (const item of importedContestBuilders) expect(validateImportedContest(item)).toEqual([]);
  });

  it('(AC-CA-IMPORT-TRACK-01) repricing alternatives retain explicit calculation context for progress monitoring', () => {
    const builder = getBuilder('contest_star_club_2026', 'version_star_club_2026_v1');
    const rookie = builder.configuration.qualification!.routes.find((route) => route.routeId === 'star_rookie')!;
    const tpc = predicates(rookie.expression).filter((node) => node.metricCode === 'TPC');
    expect(tpc.map((node) => node.context?.repricingCode)).toEqual(expect.arrayContaining(['EXCLUDING_REPRICING', 'INCLUDING_REPRICING']));
    expect(tpc.map((node) => (node.operand as { value?: string }).value)).toEqual(expect.arrayContaining(['200000.00', '240000.00']));
    expect(predicates(rookie.expression).filter((node) => node.metricCode === 'CURRENT_IPR')).toHaveLength(2);
  });

  it('(AC-CA-IMPORT-02) Wealth Planner preserves five tiers, rank exclusions and IPR gates', () => {
    const imported = getImportedCircular(getBuilder('contest_wealth_planner_2026', 'version_wealth_planner_2026_v1'))!;
    expect(imported.awardRules.map((rule) => rule.ruleId)).toEqual(['wealth_planner', 'executive_wealth', 'senior_wealth', 'premier_wealth', 'master_wealth']);
    expect(imported.audienceRules.find((rule) => !rule.include)?.rankCodes).toEqual(['AM', 'SAM']);
    expect(imported.awardRules.find((rule) => rule.ruleId === 'premier_wealth')?.options[0]?.allOf).toEqual(expect.arrayContaining([expect.objectContaining({ metricCode: 'TPC', value: '500000.00' }), expect.objectContaining({ metricCode: 'IPR', value: '85.00' })]));
  });

  it('(AC-CA-IMPORT-03) MDRT preserves FYP, FYC and income alternatives plus registration and clawback', () => {
    const imported = getImportedCircular(getBuilder('contest_mdrt_2027', 'version_mdrt_2027_v1'))!;
    expect(imported.awardRules.find((rule) => rule.ruleId === 'mdrt_tot')?.options.map((option) => option.optionCode)).toEqual(['FYP', 'FYC', 'INCOME']);
    expect(imported.awardRules.find((rule) => rule.ruleId === 'mdrt_tot')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'FYP', value: '2390400.00' });
    expect(imported.trackingRules.map((rule) => rule.type)).toEqual(expect.arrayContaining(['REGISTRATION', 'CLAWBACK']));
  });

  it('(AC-CA-IMPORT-04) Star Club preserves category tiers, case substitution and post-campaign tracking', () => {
    const imported = getImportedCircular(getBuilder('contest_star_club_2026', 'version_star_club_2026_v1'))!;
    expect(imported.awardRules.filter((rule) => rule.audienceCode === 'DIRECT_UNIT')).toHaveLength(4);
    expect(imported.awardRules.find((rule) => rule.ruleId === 'star_personal_1')?.options[0]?.allOf).toEqual(expect.arrayContaining([expect.objectContaining({ metricCode: 'CASE_COUNT', value: 30 })]));
    expect(imported.awardRules.find((rule) => rule.ruleId === 'star_top_producer')).toMatchObject({ topN: 10, rankByMetricCode: 'TPC', tieBreakMetricCode: 'CASE_COUNT' });
    expect(imported.trackingRules).toEqual(expect.arrayContaining([expect.objectContaining({ actionCode: 'EACH_CASE_SHORTFALL_REQUIRES_10000_TPC' }), expect.objectContaining({ effectiveTo: '2027-02-28', type: 'PERSISTENCY' })]));
  });

  it('(AC-CA-IMPORT-05) Top Achievers uses ranked selection and category-specific tie-breakers', () => {
    const imported = getImportedCircular(getBuilder('contest_top_achievers_2026', 'version_top_achievers_2026_v1'))!;
    expect(imported.awardRules.find((rule) => rule.ruleId === 'top_agents')).toMatchObject({ topN: 10, rankByMetricCode: 'TPC', tieBreakMetricCode: 'CASE_COUNT' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'top_recruiters')).toMatchObject({ topN: 5, rankByMetricCode: 'VNA_COUNT', tieBreakMetricCode: 'VNA_TPC' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'top_group_business_agents')).toMatchObject({ rankByMetricCode: 'APE', tieBreakMetricCode: 'NEW_ACCOUNT_COUNT' });
    expect(imported.awardRules.filter((rule) => rule.ruleId.startsWith('top_wealth_'))).toHaveLength(4);
  });

  it('(AC-CA-IMPORT-06) revised RAAP is active and ACC2026_21 remains superseded history', () => {
    const imported = getImportedCircular(getBuilder('contest_raap_2026', 'version_raap_2026_v1'))!;
    expect(imported.effectiveCircularCode).toBe('ACC2026_21a');
    expect(imported.citations.find((item) => item.circularCode === 'ACC2026_21')).toMatchObject({ status: 'SUPERSEDED', supersededBy: 'ACC2026_21a' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'raap_group_am')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'TPC', value: '1000000.00' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'raap_group_health')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'TPC', value: '1000000.00' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'raap_du_am')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'TPC', value: '500000.00' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'raap_du_um')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'TPC', value: '500000.00' });
    expect(imported.awardRules.find((rule) => rule.ruleId === 'raap_rookie')?.options[0]?.allOf[0]).toMatchObject({ metricCode: 'TPC', value: '125000.00' });
    expect(imported.awardRules.map((rule) => rule.ruleId)).toEqual(expect.arrayContaining(['raap_prumda_group', 'raap_prumda_direct', 'raap_wealth_planner']));
  });

  it('(AC-CA-IMPORT-07) Race to Yunnan preserves split-window AND and full-window OR options', () => {
    const imported = getImportedCircular(getBuilder('contest_race_yunnan_2026', 'version_race_yunnan_2026_v1'))!;
    expect(imported.periods.map((period) => period.periodId)).toEqual(['H1', 'H2', 'FULL']);
    const personal = imported.awardRules.find((rule) => rule.ruleId === 'yunnan_personal')!;
    expect(personal.options.find((option) => option.optionCode === 'SPLIT_CASES')?.allOf).toEqual([expect.objectContaining({ value: 15, periodId: 'H1' }), expect.objectContaining({ value: 15, periodId: 'H2' })]);
    expect(personal.options.find((option) => option.optionCode === 'FULL_PTPC')?.allOf[0]).toMatchObject({ value: '150000.00', periodId: 'FULL' });
  });

  it('(AC-CA-NESTED-01/02/03/04) every imported route is governed, uniquely editable and compiles alternatives to ANY of ALL groups', () => {
    for (const builder of importedContestBuilders) {
      const qualification = builder.configuration.qualification!;
      expect(new Set(qualification.routes.map((route) => route.routeId)).size).toBe(qualification.routes.length);
      for (const route of qualification.routes) {
        expect(route.expression.type).toBe('ALL');
        expect(route.rewardPolicy?.rewardCodes.length).toBeGreaterThan(0);
        expect(route.sourceCitationIds?.length).toBeGreaterThan(0);
        for (const predicate of predicates(route.expression)) expect(builder.catalogue.metrics.some((metric) => metric.code === predicate.metricCode)).toBeTruthy();
        expect(getRuleEditor(builder.contest.contestId, builder.versionId, route.routeId).issues).toEqual([]);
      }
    }
    const yunnan = getBuilder('contest_race_yunnan_2026', 'version_race_yunnan_2026_v1').configuration.qualification!.routes.find((route) => route.routeId === 'yunnan_personal')!;
    const alternatives = nodes(yunnan.expression).find((node) => node.nodeId === 'yunnan_personal_alternatives');
    expect(alternatives).toMatchObject({ type: 'ANY', minimumPass: 1 });
    expect(alternatives && alternatives.type === 'ANY' && alternatives.children.every((child) => child.type === 'ALL')).toBeTruthy();
  });

  it('(AC-CA-PRODUCT-01/02/03/04/12/13) product, rider and business-line rules are editable nested LOV predicates', () => {
    const raap = getBuilder('contest_raap_2026', 'version_raap_2026_v1');
    const health = raap.configuration.qualification!.routes.find((route) => route.routeId === 'raap_health')!;
    const healthPredicates = predicates(health.expression);
    expect(healthPredicates.find((node) => node.metricCode === 'BUSINESS_LINE')?.operand).toMatchObject({ kind: 'LOV_SET', valueCodes: ['INSURANCE'] });
    expect(healthPredicates.find((node) => node.metricCode === 'PRODUCT_CODE')?.operand).toMatchObject({ kind: 'LOV_SET', valueCodes: ['PRUWITH_YOU', 'PRUWITH_YOU_PLUS'] });
    expect(healthPredicates.find((node) => node.metricCode === 'RIDER_CODE')?.operand).toMatchObject({ kind: 'LOV_SET' });
    expect(healthPredicates.filter((node) => ['BUSINESS_LINE', 'PRODUCT_CODE', 'RIDER_CODE'].includes(node.metricCode)).every((node) => node.sourceCitationIds?.length)).toBeTruthy();
  });

  it('(AC-CA-PRODUCT-06/14/15) exclusions compile as NOT groups and survive in authoritative routes', () => {
    const yunnan = getBuilder('contest_race_yunnan_2026', 'version_race_yunnan_2026_v1').configuration.qualification!.routes.find((route) => route.routeId === 'yunnan_personal')!;
    const yunnanNot = nodes(yunnan.expression).find((node) => node.nodeId === 'yunnan_personal_excluded_products');
    expect(yunnanNot).toMatchObject({ type: 'NOT', child: { type: 'PREDICATE', metricCode: 'PRODUCT_FAMILY', operand: { kind: 'LOV_SET', valueCodes: ['UNIT_TRUST', 'GROUP_BUSINESS'] } } });
    const wealth = getBuilder('contest_wealth_planner_2026', 'version_wealth_planner_2026_v1').configuration.qualification!.routes.find((route) => route.routeId === 'premier_wealth')!;
    expect(predicates(wealth.expression).find((node) => node.nodeId === 'premier_wealth_included_products')).toMatchObject({ metricCode: 'PRODUCT_FAMILY', operand: { valueCodes: ['CONVENTIONAL_LIFE', 'FAMILY_TAKAFUL', 'SINGLE_PREMIUM', 'PSA', 'GROUP_BUSINESS'] } });
    expect(nodes(wealth.expression).find((node) => node.nodeId === 'premier_wealth_exclude_products')).toMatchObject({ type: 'NOT', child: { metricCode: 'PRODUCT_FAMILY', operand: { valueCodes: ['UNIT_TRUST', 'GROUP_RENEWAL'] } } });
  });
});
