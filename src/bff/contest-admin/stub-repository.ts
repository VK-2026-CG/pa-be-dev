/**
 * Dead-code demo/stub repository, kept only because `test/contest-admin.spec.ts`
 * (relocated from pa-fe-dev) still exercises it to validate the imported-contest
 * fixtures and rule-validation logic in isolation from the real Contest domain.
 * Not wired into any BFF route — `contest-service.ts`/`rule-service.ts` talk to
 * the real `/contests/v1` domain via `domain-client.ts` instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCountryContext } from '../../config/country.js';
import type {
  ApprovalInboxVM, AssetVM, AuditLogVM, ContestBuilderVM, ContestPortfolioVM,
  ContestProblemVM, ContestSummaryVM, ReviewVM, RuleEditorVM, RuleLibraryVM, SimulationWorkspaceVM,
  CreateContestRequestVM, SaveRuleRequestVM, StartSimulationRequestVM,
  CreateRuleAssetRequestVM, CreateRuleAssetResultVM,
  CreateQualificationRouteRequestVM, QualificationRouteVM,
  SubmitContestRequestVM, SubmitContestResultVM, ApprovalDecisionRequestVM, ApprovalDecisionResultVM, AuditExportVM,
  RuleExpressionVM, RulePredicateVM, ValidationIssueVM,
} from '../../../vendor/spec/contest-admin-vm.js';
import { contestAdminConfig } from './config.js';
import { importedContestBuilders } from './imported-contests.js';
import { governedContestCatalogue } from './governed-catalogue.js';

const FIXTURES_BASE = new URL('../../../vendor/spec/contest-admin-fixtures/', import.meta.url);
const readFixture = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURES_BASE)), 'utf8')) as T;
const portfolioFixture = readFixture<unknown>('portfolio.json');
const builderFixture = readFixture<unknown>('builder.json');
const approvalFixture = readFixture<unknown>('approval-inbox.json');
const simulationFixture = readFixture<unknown>('simulation-running.json');

const clone = <T>(value: T): T => structuredClone(value);
const meta = {
  traceId: '0000000000000000000000000000ca10',
  generatedAt: '2026-08-21T00:00:00Z',
  permissions: ['contests:read', 'contests:write', 'contests:submit', 'contests:simulate', 'contests:audit:read'],
};

let builder = clone(builderFixture) as ContestBuilderVM;
type ContestDetailStub = ContestSummaryVM & { country: string; timezone: string; latestVersionId: string };
interface ContestStubState {
  builders: Map<string, ContestBuilderVM>;
  createdByIdempotencyKey: Map<string, ContestDetailStub>;
  rules: Map<string, RuleEditorVM>;
  commands: Map<string, unknown>;
  simulationPolls: number;
}
const processState = globalThis as typeof globalThis & { __contestAdminStubState?: ContestStubState };
const state = processState.__contestAdminStubState ??= {
  builders: new Map([
    [`${builder.contest.contestId}:${builder.versionId}`, builder],
    ...importedContestBuilders.map((item) => [`${item.contest.contestId}:${item.versionId}`, clone(item)] as const),
  ]),
  createdByIdempotencyKey: new Map(),
  rules: new Map(), commands: new Map(), simulationPolls: 0,
};
const builders = state.builders;
const createdByIdempotencyKey = state.createdByIdempotencyKey;

function visitRule(node: RuleExpressionVM, path = '/expression', depth = 1): Array<{node:RuleExpressionVM;path:string;depth:number}> {
  const current = [{ node, path, depth }];
  if (node.type === 'ALL' || node.type === 'ANY') return current.concat(node.children.flatMap((child, index) => visitRule(child, `${path}/children/${index}`, depth + 1)));
  if (node.type === 'NOT') return current.concat(visitRule(node.child, `${path}/child`, depth + 1));
  return current;
}

function validateRule(expression: RuleExpressionVM, catalogue=builder.catalogue): ValidationIssueVM[] {
  const visited = visitRule(expression);
  const issues: ValidationIssueVM[] = [];
  const add = (code:string, path:string, messageKey:string) => issues.push({ issueId:`rule_${issues.length + 1}`, severity:'ERROR', code, path, messageKey, acknowledgementAllowed:false });
  if (visited.length > contestAdminConfig.builder.maxRuleNodes) add('RULE_NODE_LIMIT', '/expression', 'contest.error.ruleLimit');
  if (Math.max(...visited.map(item => item.depth)) > contestAdminConfig.builder.maxRuleDepth) add('RULE_DEPTH_LIMIT', '/expression', 'contest.error.ruleDepth');
  const ids = new Set<string>();
  for (const item of visited) {
    const nodePath = `/expression/nodes/${item.node.nodeId}`;
    if (ids.has(item.node.nodeId)) add('DUPLICATE_NODE_ID', `${nodePath}/nodeId`, 'contest.error.duplicateNodeId');
    ids.add(item.node.nodeId);
    if ((item.node.type === 'ALL' || item.node.type === 'ANY') && item.node.children.length === 0) add('EMPTY_GROUP', `${nodePath}/children`, 'contest.error.emptyGroup');
    if(item.node.type==='ANY'&&item.node.minimumPass!==undefined&&(item.node.minimumPass<1||item.node.minimumPass>item.node.children.length))add('INVALID_MINIMUM_PASS',`${nodePath}/minimumPass`,'contest.error.minimumPass');
    if (item.node.type !== 'PREDICATE') continue;
    const predicate = item.node;
    const metric = catalogue.metrics.find(candidate => candidate.code === predicate.metricCode);
    if (!metric) { add('UNKNOWN_METRIC', `${nodePath}/metricCode`, 'contest.error.unknownMetric'); continue; }
    if (!metric.operators.includes(predicate.operator)) add('INVALID_OPERATOR', `${nodePath}/operator`, 'contest.error.invalidOperator');
    if (predicate.operator !== 'EXISTS' && !predicate.operand) add('OPERAND_REQUIRED', `${nodePath}/operand`, 'contest.error.operandRequired');
    if (metric.operandLovKey && predicate.operand && !['LOV','LOV_SET'].includes(predicate.operand.kind)) add('INVALID_OPERAND_TYPE', `${nodePath}/operand`, 'contest.error.invalidOperand');
    if (!metric.operandLovKey && predicate.operand?.kind === 'LOV') add('INVALID_OPERAND_TYPE', `${nodePath}/operand`, 'contest.error.invalidOperand');
    if(metric.operandLovKey&&predicate.operand&&(predicate.operand.kind==='LOV'||predicate.operand.kind==='LOV_SET')){const definition=catalogue.lovs.find(lov=>lov.key===metric.operandLovKey);const codes=predicate.operand.kind==='LOV'?[predicate.operand.valueCode]:predicate.operand.valueCodes;if(!definition||codes.length===0||codes.some(code=>!definition.values.some(value=>value.code===code&&value.status==='ACTIVE')))add('UNKNOWN_LOV_VALUE',`${nodePath}/operand`,'contest.error.unknownLovValue');}
    if(predicate.operator==='BETWEEN'&&predicate.operand&&predicate.operand.kind!=='RANGE'&&predicate.operand.kind!=='DATE_RANGE')add('INVALID_RANGE',`${nodePath}/operand`,'contest.error.invalidRange');
  }
  return issues;
}

const assets: AssetVM[] = [
  { assetId: 'rule_ca01', code: 'MINIMUM_TPC', type: 'RULE', categoryCode: 'ELIGIBILITY', status: 'APPROVED', latestVersion: '2.1', adoptionCount: 26, nav: { route: '/contest-admin/rules' } },
  { assetId: 'rule_ca02', code: 'PERSISTENCY_GATE', type: 'RULE', categoryCode: 'QUALITY', status: 'IN_REVIEW', latestVersion: '1.2', adoptionCount: 11, nav: { route: '/contest-admin/rules' } },
];

export class ContestStubError extends Error {
  constructor(public status: number, public problem: ContestProblemVM) { super(problem.code); }
}

function problem(status: number, code: string, messageKey: string): never {
  throw new ContestStubError(status, { status, code, messageKey, traceId: meta.traceId });
}

export function getPortfolio(query: URLSearchParams): ContestPortfolioVM {
  const value = clone(portfolioFixture) as ContestPortfolioVM;
  value.contests = [...builders.values()].filter((item) => item.configuration.importedCircular).map((item) => item.contest);
  value.metrics = value.metrics.map((metric) => metric.code === 'TOTAL_CONTESTS' ? { ...metric, value:value.contests.length } : metric);
  value.filters.statuses = ['DRAFT'];
  const search = query.get('query')?.trim().toLowerCase();
  const status = query.get('status');
  value.contests = value.contests.filter((contest) => (!search || `${contest.code} ${contest.nameKey} ${contest.ownerRef}`.toLowerCase().includes(search)) && (!status || contest.status === status));
  value.page.count = value.contests.length;
  return value;
}

export function getBuilder(contestId: string, versionId: string): ContestBuilderVM {
  const current = builders.get(`${contestId}:${versionId}`);
  if (!current) problem(404, 'CON-4041', 'contest.error.notFound');
  const value = clone(current);
  value.steps = contestAdminConfig.builder.stepOrder.map((stepCode) => value.steps.find((step) => step.stepCode === stepCode) ?? {
    stepCode, status: 'NOT_STARTED', issueCount: 0,
    nav: { route: `/contest-admin/contests/${contestId}/versions/${versionId}/edit/${stepCode}` },
  });
  return value;
}

export function patchBuilder(contestId: string, versionId: string, ifMatch: string | null, configuration: Record<string, unknown>): ContestBuilderVM {
  const current = getBuilder(contestId, versionId);
  if (current.readOnly) problem(409, 'CON-4091', 'contest.error.readOnly');
  if (ifMatch !== current.etag) problem(412, 'CON-4121', 'contest.error.conflict');
  builder = { ...current, configuration: { ...current.configuration, ...configuration }, revision: current.revision + 1, etag: `"revision-${current.revision + 1}"`, autosave: { state: 'SAVED', savedAt: new Date().toISOString() } };
  builders.set(`${contestId}:${versionId}`, builder);
  return getBuilder(contestId, versionId);
}

export function createContest(request: CreateContestRequestVM, idempotencyKey: string | null) {
  if (!idempotencyKey) problem(422, 'CON-4221', 'contest.error.idempotencyRequired');
  const prior = createdByIdempotencyKey.get(idempotencyKey);
  if (prior) return clone(prior);
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(request.code)) problem(422, 'CON-4222', 'contest.error.invalidCode');
  if ([...builders.values()].some((item) => item.contest.code === request.code)) problem(409, 'CON-4093', 'contest.error.duplicateCode');
  const suffix = request.code.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  const contestId = `contest_${suffix}`;
  const versionId = `version_${suffix}_v1`;
  const now = new Date().toISOString();
  const contest: ContestSummaryVM = {
    contestId, code: request.code, nameKey: request.nameKey, status: 'DRAFT', ownerRef: 'user_ref_current',
    campaignStart: '2027-01-01', campaignEnd: '2027-12-31', audienceCodes: [], ruleCount: 0, updatedAt: now,
    nav: { route: `/contest-admin/contests/${contestId}/versions/${versionId}/edit/BASICS` },
  };
  const snapshot: ContestBuilderVM = {
    meta: clone(meta), contest, versionId, revision: 1, etag: '"revision-1"', readOnly: false,
    steps: contestAdminConfig.builder.stepOrder.map((stepCode) => ({ stepCode, status: 'NOT_STARTED', issueCount: 0, nav: { route: `/contest-admin/contests/${contestId}/versions/${versionId}/edit/${stepCode}` } })),
    activeStep: 'BASICS', configuration: { basics: { nameKey: request.nameKey } }, catalogue:clone(governedContestCatalogue),
    validation: { blocking: true, issues: [] }, autosave: { state: 'IDLE' },
  };
  builders.set(`${contestId}:${versionId}`, snapshot);
  const detail = { ...contest, country: getCountryContext().countryCode, timezone: request.timezone, latestVersionId: versionId };
  createdByIdempotencyKey.set(idempotencyKey, detail);
  return clone(detail);
}

export function createQualificationRoute(contestId:string,versionId:string,request:CreateQualificationRouteRequestVM,idempotencyKey:string|null):QualificationRouteVM {
  if(!idempotencyKey)problem(422,'CON-4221','contest.error.idempotencyRequired');
  const commandKey=`create-route:${contestId}:${versionId}:${idempotencyKey}`;
  const prior=state.commands.get(commandKey) as QualificationRouteVM|undefined;if(prior)return clone(prior);
  const current=getBuilder(contestId,versionId);if(current.etag!==request.etag)problem(412,'CON-4121','contest.error.conflict');
  if(!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(request.code))problem(422,'CON-4222','contest.error.invalidCode');
  if(!governedContestCatalogue.lovs.find(lov=>lov.key==='qualifier.type')?.values.some(value=>value.code===request.audienceCode))problem(422,'CON-4231','contest.error.routeAudienceInvalid');
  const existing=current.configuration.qualification;
  if(existing?.routes.some(route=>route.code===request.code))problem(409,'CON-4093','contest.error.duplicateCode');
  const routeId=`route_${request.code.toLowerCase().replaceAll(/[^a-z0-9]+/g,'_')}`;
  const initialMetric=current.catalogue.metrics.find(metric=>metric.code==='TPC')!;
  if(!request.name.trim())problem(422,'CON-4232','contest.error.routeNameRequired');
  const route:QualificationRouteVM={routeId,code:request.code,labelKey:'contest.route.custom',name:request.name.trim(),order:(existing?.routes.length??0)+1,enabled:true,audienceCode:request.audienceCode,expression:{nodeId:`${routeId}_root`,type:request.rootType,children:[{nodeId:`${routeId}_condition_1`,type:'PREDICATE',metricCode:initialMetric.code,operator:'GTE',operand:{kind:'MONEY',value:'0.00',currency:'MYR'}}]},tierIds:[`tier_${request.tierCode.toLowerCase()}`],selectionPolicy:{mode:'ALL_QUALIFIERS'},rewardPolicy:{rewardCodes:[request.rewardCode],precedenceCode:'HIGHEST_ELIGIBLE'}};
  const tier={tierId:`tier_${request.tierCode.toLowerCase()}`,code:request.tierCode,labelKey:'contest.route.custom',order:(existing?.tiers.length??0)+1,rewardCode:request.rewardCode};
  const qualification={routes:[...(existing?.routes??[]),route],tiers:[...(existing?.tiers??[]),tier],periods:existing?.periods??[{periodId:'FULL',labelKey:'contest.period.FULL',order:1}],targets:existing?.targets??[],rewardPrecedenceCode:existing?.rewardPrecedenceCode??'HIGHEST_ELIGIBLE'};
  const revision=current.revision+1;const next={...current,revision,etag:`"revision-${revision}"`,configuration:{...current.configuration,qualification},autosave:{state:'SAVED' as const,savedAt:new Date().toISOString()}};
  builders.set(`${contestId}:${versionId}`,next);state.commands.set(commandKey,route);return clone(route);
}

export function getReview(contestId=builder.contest.contestId,versionId=builder.versionId): ReviewVM {
  const current=getBuilder(contestId,versionId);
  return {
    meta: clone(meta), contest: clone(current.contest), versionId: current.versionId,
    checksum: `sha256:${current.versionId}:review-snapshot`,
    sections: contestAdminConfig.builder.stepOrder.map((stepCode) => ({ stepCode, status: current.steps.find(step=>step.stepCode===stepCode)?.status??'NOT_STARTED', summaryKeys: [], editNav: { route: `/contest-admin/contests/${current.contest.contestId}/versions/${current.versionId}/edit/${stepCode}` } })),
    changes: [{ changeId: 'change_ca01', operation: 'MODIFIED', path: '/configuration/basics/timezone', materiality: 'NON_MATERIAL' }],
    validation: clone(current.validation),
    approvalStages: [{ stageId: 'business', order: 1, type: 'BUSINESS_CHECKER', status: 'PENDING' }, { stageId: 'risk', order: 2, type: 'RISK', status: 'WAITING' }],
  };
}

export const getRules = (): RuleLibraryVM => ({ meta: clone(meta), items: clone(assets.filter((asset) => asset.type === 'RULE')), filters: { categoryCodes: ['ELIGIBILITY', 'QUALITY'], statuses: ['APPROVED', 'IN_REVIEW'] } });
export function createRuleAsset(request:CreateRuleAssetRequestVM,idempotencyKey:string|null):CreateRuleAssetResultVM {
  if(!idempotencyKey) problem(422,'CON-4221','contest.error.idempotencyRequired');
  const commandKey=`create-rule:${idempotencyKey}`;
  const prior=state.commands.get(commandKey) as CreateRuleAssetResultVM|undefined;
  if(prior)return clone(prior);
  if(!request.name.trim())problem(422,'CON-4228','contest.error.ruleNameRequired');
  if(!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(request.code))problem(422,'CON-4222','contest.error.invalidCode');
  if(!['ELIGIBILITY','QUALITY','PRODUCTION'].includes(request.categoryCode))problem(422,'CON-4229','contest.error.ruleCategoryInvalid');
  if(!['ALL','ANY'].includes(request.rootType))problem(422,'CON-4230','contest.error.ruleLogicInvalid');
  if(assets.some(asset=>asset.type==='RULE'&&asset.code===request.code))problem(409,'CON-4093','contest.error.duplicateCode');
  const suffix=request.code.toLowerCase().replaceAll(/[^a-z0-9]+/g,'_');
  const assetId=`rule_${suffix}`,latestVersionId=`ruleversion_${suffix}_v1`;
  const created:CreateRuleAssetResultVM={assetId,code:request.code,name:request.name.trim(),type:'RULE',categoryCode:request.categoryCode,status:'DRAFT',latestVersion:'0.1',latestVersionId,adoptionCount:0,rootType:request.rootType,nav:{route:`/contest-admin/rules/${assetId}/versions/${latestVersionId}`}};
  assets.push(created);state.commands.set(commandKey,created);return clone(created);
}
export const getApprovals = (inbox = 'ASSIGNED'): ApprovalInboxVM => ({ ...(clone(approvalFixture) as ApprovalInboxVM), inbox: (['ASSIGNED', 'SUBMITTED', 'COMPLETED'].includes(inbox) ? inbox : 'ASSIGNED') as ApprovalInboxVM['inbox'] });
export const getAudit = (): AuditLogVM => ({ meta: clone(meta), items: [
  { eventId: 'event_ca03', occurredAt: '2026-08-21T09:15:00Z', actorRef: 'user_ref_02', action: 'VERSION_VALIDATED', resourceType: 'CONTEST_VERSION', resourceId: builder.versionId, outcome: 'SUCCEEDED', detailNav: { route: `/contest-admin/contests/${builder.contest.contestId}/versions/${builder.versionId}/review` } },
  { eventId: 'event_ca02', occurredAt: '2026-08-21T08:45:00Z', actorRef: 'user_ref_01', action: 'DRAFT_UPDATED', resourceType: 'CONTEST_VERSION', resourceId: builder.versionId, outcome: 'SUCCEEDED' },
  { eventId: 'event_ca01', occurredAt: '2026-08-20T17:30:00Z', actorRef: 'user_ref_01', action: 'CONTEST_CREATED', resourceType: 'CONTEST', resourceId: builder.contest.contestId, outcome: 'SUCCEEDED' },
], page: { hasMore: false, count: 3 } });
export const getSimulation = (contestId=builder.contest.contestId,versionId=builder.versionId): SimulationWorkspaceVM => ({...(clone(simulationFixture) as SimulationWorkspaceVM),contestId,versionId});
export function getRuleEditor(contestId = builder.contest.contestId, versionId = builder.versionId, ruleId = 'rule_ca01'): RuleEditorVM {
  const key = `${contestId}:${versionId}:${ruleId}`;
  const current = getBuilder(contestId, versionId);
  const route = current.configuration.qualification?.routes.find((item) => item.routeId === ruleId) ?? (contestId===builder.contest.contestId&&ruleId==='rule_ca01'?current.configuration.qualification?.routes[0]:undefined);
  if(!route)problem(404,'CON-4041','contest.error.notFound');
  const expression = route?.expression ?? { nodeId:'root_all', type:'ALL', children:[] };
  return clone(state.rules.get(key) ?? { meta: clone(meta), contestId, versionId, ruleId, categoryCode: route?.code ?? 'PERSONAL', tierCode: route?.tierIds[0] ?? 'TIER_A', expression, options: { periodMode:'CUMULATIVE', unknownCodePolicy:'BLOCK' }, catalogue:clone(current.catalogue), limits:{ maxDepth:contestAdminConfig.builder.maxRuleDepth, maxNodes:contestAdminConfig.builder.maxRuleNodes }, issues:validateRule(expression,current.catalogue) });
}

export function saveRule(contestId:string, versionId:string, ruleId:string, request:SaveRuleRequestVM): RuleEditorVM {
  const current = getBuilder(contestId, versionId);
  if (request.etag !== current.etag) problem(412, 'CON-4121', 'contest.error.conflict');
  const issues = validateRule(request.expression,current.catalogue);
  if (issues.length) throw new ContestStubError(422, { status:422, code:'CON-4224', messageKey:'contest.error.ruleInvalid', traceId:meta.traceId, errors:issues.map(issue => ({ path:issue.path, code:issue.code, messageKey:issue.messageKey })) });
  const routeId=contestId===builder.contest.contestId&&ruleId==='rule_ca01'?'route_personal':ruleId;
  const qualification=current.configuration.qualification;
  const route=qualification?.routes.find(item=>item.routeId===routeId);
  if(!qualification||!route)problem(404,'CON-4041','contest.error.notFound');
  const nextRevision=current.revision+1;
  const next:ContestBuilderVM={...current,revision:nextRevision,etag:`"revision-${nextRevision}"`,configuration:{...current.configuration,qualification:{...qualification,routes:qualification.routes.map(item=>item.routeId===routeId?{...item,expression:clone(request.expression)}:item)},provenance:{...(current.configuration.provenance as Record<string,unknown>|undefined),lastRuleEdit:{routeId,editedAt:new Date().toISOString()}}},autosave:{state:'SAVED',savedAt:new Date().toISOString()}};
  builders.set(`${contestId}:${versionId}`,next);
  if(contestId===builder.contest.contestId)builder=next;
  const saved:RuleEditorVM = { ...getRuleEditor(contestId, versionId, ruleId), expression:clone(request.expression), options:clone(request.options), issues:[] };
  state.rules.delete(`${contestId}:${versionId}:${ruleId}`);
  return clone(saved);
}

export function testRule(contestId:string, versionId:string, ruleId:string, request:SaveRuleRequestVM): RuleEditorVM {
  const current=getBuilder(contestId,versionId);
  const issues = validateRule(request.expression,current.catalogue);
  const value:RuleEditorVM = { ...getRuleEditor(contestId, versionId, ruleId), expression:clone(request.expression), options:clone(request.options), issues };
  value.testResult = { qualificationStatus:issues.length ? 'NOT_QUALIFIED' : 'QUALIFIED', metrics:[{ metricCode:'TPC', kind:'MONEY', value:'125000.00', currency:'MYR' }], nodeResults:visitRule(request.expression).map(({node}) => ({ nodeId:node.nodeId, passed:issues.length === 0, ...(node.type === 'PREDICATE' ? { normalizedValue:operandDisplay(node), sourceCitationIds:node.sourceCitationIds } : {}) })), configurationChecksum:`sha256:${versionId}:${ruleId}:rules`, engineVersion:'contest-engine-stub-0.1.0' };
  return value;
}

function operandDisplay(node:RulePredicateVM):string|number|boolean|undefined {
  if (!node.operand) return undefined;
  if ('value' in node.operand) return node.operand.value;
  if ('valueCode' in node.operand) return node.operand.valueCode;
  if ('valueCodes' in node.operand) return node.operand.valueCodes.join(',');
  return `${node.operand.from}/${node.operand.to}`;
}

export function startSimulation(request:StartSimulationRequestVM, idempotencyKey:string|null,contestId=builder.contest.contestId,versionId=builder.versionId):SimulationWorkspaceVM {
  if (!idempotencyKey) problem(422, 'CON-4221', 'contest.error.idempotencyRequired');
  const commandKey=`simulation:${contestId}:${versionId}:${idempotencyKey}`;
  const prior = state.commands.get(commandKey) as SimulationWorkspaceVM | undefined; if (prior) return clone(prior);
  state.simulationPolls = 0;
  getBuilder(contestId,versionId);
  const value:SimulationWorkspaceVM = { meta:clone(meta), contestId, versionId, allowedTypes:['SAMPLE_PARTICIPANT','PORTFOLIO_IMPACT'], simulation:{ jobId:'simjob_started', status:'QUEUED', progressPct:0, type:request.type } };
  state.commands.set(commandKey, value); state.commands.set(`simulation:current:${contestId}:${versionId}`, value);
  return clone(value);
}

export function pollSimulation(contestId=builder.contest.contestId,versionId=builder.versionId):SimulationWorkspaceVM {
  const current = state.commands.get(`simulation:current:${contestId}:${versionId}`) as SimulationWorkspaceVM | undefined;
  if (!current) return getSimulation(contestId,versionId);
  state.simulationPolls += 1;
  if (current.simulation) current.simulation = state.simulationPolls > 1 ? { ...current.simulation, status:'COMPLETED', progressPct:100, summary:{ processed:1000, total:1000, qualified:640 } } : { ...current.simulation, status:'RUNNING', progressPct:55, summary:{ processed:550, total:1000 } };
  state.commands.set(`simulation:current:${contestId}:${versionId}`, current); return clone(current);
}

export function submitContest(versionId:string, ifMatch:string|null, idempotencyKey:string|null, request:SubmitContestRequestVM):SubmitContestResultVM {
  if (!idempotencyKey) problem(422, 'CON-4221', 'contest.error.idempotencyRequired');
  const prior = state.commands.get(`submit:${idempotencyKey}`) as SubmitContestResultVM | undefined; if (prior) return clone(prior);
  const current = [...builders.values()].find(item => item.versionId === versionId); if (!current) problem(404, 'CON-4041', 'contest.error.notFound');
  if (ifMatch !== current.etag) problem(409, 'CON-4092', 'contest.error.staleSnapshot');
  if (!request.attested) problem(422, 'CON-4225', 'contest.error.attestationRequired');
  if (current.validation.blocking) problem(422, 'CON-4226', 'contest.error.validationBlocking');
  const result:SubmitContestResultVM = { approvalId:`approval_${versionId}`, versionId, snapshotChecksum:`sha256:${versionId}:frozen`, status:'IN_PROGRESS', nav:{ route:'/contest-admin/approvals?inbox=SUBMITTED' } };
  state.commands.set(`submit:${idempotencyKey}`, result); return clone(result);
}

export function decideApproval(approvalId:string, ifMatch:string|null, idempotencyKey:string|null, request:ApprovalDecisionRequestVM, actor='checker_ref'):ApprovalDecisionResultVM {
  if (!idempotencyKey) problem(422, 'CON-4221', 'contest.error.idempotencyRequired');
  const prior = state.commands.get(`decision:${idempotencyKey}`) as ApprovalDecisionResultVM | undefined; if (prior) return clone(prior);
  if (actor === 'user_ref_01') problem(403, 'CON-4032', 'contest.error.selfDecision');
  if (ifMatch !== '"approval-revision-1"') problem(409, 'CON-4092', 'contest.error.staleSnapshot');
  if (request.decision === 'RETURN' && !request.comment?.trim()) problem(422, 'CON-4227', 'contest.error.returnComment');
  const result:ApprovalDecisionResultVM = { approvalId, status:request.decision === 'APPROVE' ? 'APPROVED' : request.decision === 'RETURN' ? 'RETURNED' : 'REJECTED', decidedAt:new Date().toISOString(), ...(request.decision === 'RETURN' ? { editableDraftNav:{ route:`/contest-admin/contests/contest_ca0001/versions/version_returned/edit/BASICS` } } : {}) };
  state.commands.set(`decision:${idempotencyKey}`, result); return clone(result);
}

export function startAuditExport(idempotencyKey:string|null):AuditExportVM {
  if (!idempotencyKey) problem(422, 'CON-4221', 'contest.error.idempotencyRequired');
  const prior = state.commands.get(`export:${idempotencyKey}`) as AuditExportVM | undefined; if (prior) return clone(prior);
  const value:AuditExportVM = { jobId:'audit_export_ca01', status:'QUEUED' }; state.commands.set(`export:${idempotencyKey}`, value); return clone(value);
}
