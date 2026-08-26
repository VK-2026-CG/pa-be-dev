import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { SpecContestRepository } from '../src/contest/spec-repository.js';
import { validateRuleExpression } from '../src/contest/rule-engine.js';

process.env.MONGODB_URI = '';
const source = await createSource();
const H = (agent = 'A1001', extra: Record<string, string> = {}) => ({ 'x-agent-id': agent, 'x-tenant': 'MY', ...extra });
const command = (agent = 'A1001', extra: Record<string, string> = {}) => H(agent, { 'idempotency-key': `key-${agent}-0001`, ...extra });
const app = () => buildApp(source, new SpecContestRepository());

describe('contests.v1 OpenAPI contract', () => {
  it('validates imported ACC metrics and active LOV values against the MY-2026 catalogue', () => {
    const expression={nodeId:'root_imported_acc',type:'ALL',children:[
      {nodeId:'imported_tpc_gate',type:'PREDICATE',metricCode:'TPC',operator:'GTE',operand:{kind:'MONEY',value:'125000.00',currency:'MYR'}},
      {nodeId:'imported_rank_gate',type:'PREDICATE',metricCode:'AGENT_LEVEL',operator:'IN',operand:{kind:'LOV_SET',lovKey:'agent.level',valueCodes:['AGENT','UM1','UM2']}},
      {nodeId:'imported_product_gate',type:'PREDICATE',metricCode:'PRODUCT_CODE',operator:'IN',operand:{kind:'LOV_SET',lovKey:'product.code',valueCodes:['PRUWITH_YOU_PLUS']}},
    ]};
    expect(validateRuleExpression(expression,{periodMode:'FULL_CAMPAIGN',unknownCodePolicy:'BLOCK'})).toMatchObject({valid:true,catalogueVersion:'MY-2026.2'});
    const unknown={...expression,children:[expression.children[0],{...expression.children[1]!,operand:{kind:'LOV_SET',lovKey:'agent.level',valueCodes:['UNKNOWN_RANK']}},expression.children[2]]};
    expect(validateRuleExpression(unknown,{periodMode:'FULL_CAMPAIGN',unknownCodePolicy:'BLOCK'}).issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_OPERAND'})]));
  });
  it('creates C1 identity/version models and returns OpenAPI field names', async () => {
    const server = app();
    const missingKey = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: H(), payload: { code: 'ACC2026', nameKey: 'contest.acc2026', timezone: 'Asia/Kuala_Lumpur' } });
    expect(missingKey.statusCode).toBe(400); expect(missingKey.json().code).toBe('CON-4001');
    const selectedCountry = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: command('A1001', { 'idempotency-key': 'country-selected' }), payload: { code: 'ACC2026', nameKey: 'contest.acc2026', country: 'PH', timezone: 'Asia/Manila' } });
    expect(selectedCountry.statusCode).toBe(400);
    const created = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: command(), payload: { code: 'ACC2026', nameKey: 'contest.acc2026', timezone: 'Asia/Kuala_Lumpur' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ contestId: expect.any(String), code: 'ACC2026', nameKey: 'contest.acc2026', country: 'MY', status: 'DRAFT', latestVersionId: expect.any(String) });
    expect(created.json().id).toBeUndefined();
    const version = await server.inject({ url: `/contests/v1/contest-versions/${created.json().latestVersionId}`, headers: H() });
    expect(version.statusCode).toBe(200); expect(version.headers.etag).toBe('"1"');
    expect(version.json()).toMatchObject({ versionId: created.json().latestVersionId, revision: 1, configuration: { basics: { code: 'ACC2026' } } });
  });

  it('projects API-patched configuration into the contest portfolio summary', async () => {
    const server = app();
    const created = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: command('A1001', { 'idempotency-key': 'portfolio-projection' }), payload: { code: 'PROJECT2026', nameKey: 'contest.created.new', timezone: 'Asia/Kuala_Lumpur' } });
    const versionId = created.json().latestVersionId;
    const configuration = { audience: { rules: [] }, qualification: { routes: [{ routeId: 'route_one', audienceCode: 'PERSONAL' }] }, importedCircular: { periods: [{ periodId: 'FULL', from: '2026-01-01', to: '2026-12-31' }] } };
    const patched = await server.inject({ method: 'PATCH', url: `/contests/v1/contest-versions/${versionId}`, headers: H('A1001', { 'if-match': '"1"' }), payload: configuration });
    expect(patched.statusCode).toBe(200);
    const portfolio = await server.inject({ url: '/contests/v1/contests?query=PROJECT2026', headers: H() });
    expect(portfolio.json().items[0]).toMatchObject({ campaignStart: '2026-01-01', campaignEnd: '2026-12-31', audienceCodes: ['PERSONAL'], ruleCount: 1 });
  });

  it('enforces draft CAS, deterministic validation and maker-checker', async () => {
    const server = app();
    const created = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: command(), payload: { code: 'CAS2026', nameKey: 'contest.cas', timezone: 'Asia/Kuala_Lumpur' } });
    const versionId = created.json().latestVersionId;
    const stale = await server.inject({ method: 'PATCH', url: `/contests/v1/contest-versions/${versionId}`, headers: H('A1001', { 'if-match': '"2"' }), payload: { audience: { channelCodes: ['AGENCY'] } } });
    expect(stale.statusCode).toBe(412); expect(stale.json().code).toBe('CON-4121');
    const patched = await server.inject({ method: 'PATCH', url: `/contests/v1/contest-versions/${versionId}`, headers: H('A1001', { 'if-match': '"1"' }), payload: { audience: { channelCodes: ['AGENCY'] }, qualification: { routes: [] }, calculation: { metrics: [] }, rewards: { tiers: [] }, governance: { stages: [] } } });
    expect(patched.statusCode).toBe(200); expect(patched.headers.etag).toBe('"2"');
    const validation = await server.inject({ method: 'POST', url: `/contests/v1/contest-versions/${versionId}/validate`, headers: command() });
    expect(validation.json()).toMatchObject({ status: 'VALID', issues: [] });
    const submitted = await server.inject({ method: 'POST', url: `/contests/v1/contest-versions/${versionId}/submit`, headers: command('A1001', { 'if-match': '"2"' }), payload: { attested: true, changeRationale: 'Ready for review' } });
    expect(submitted.statusCode).toBe(201);
    const denied = await server.inject({ method: 'POST', url: `/contests/v1/approvals/${submitted.json().approvalId}/decisions`, headers: command('A1001', { 'if-match': '"1"' }), payload: { decision: 'APPROVE' } });
    expect(denied.statusCode).toBe(403); expect(denied.json().code).toBe('CON-4032');
    const approved = await server.inject({ method: 'POST', url: `/contests/v1/approvals/${submitted.json().approvalId}/decisions`, headers: command('L2001', { 'if-match': '"1"' }), payload: { decision: 'APPROVE' } });
    expect(approved.statusCode).toBe(200); expect(approved.json().status).toBe('APPROVED');
    const publish = await server.inject({ method: 'POST', url: `/contests/v1/contest-versions/${versionId}/publish`, headers: command('L2001') });
    expect(publish.statusCode).toBe(202); expect(publish.json()).toMatchObject({ type: 'PUBLICATION', status: 'ACCEPTED' });
  });

  it('registers immutable source manifests and rejects checksum reuse', async () => {
    const server = app();
    const manifest = { sourceBatchId: 'agent-master-batch-001', sourceType: 'AGENT_MASTER', businessDate: '2026-07-27', schemaVersion: '0.1.0', objectUri: 's3://controlled/agent.json', sha256: 'a'.repeat(64), rowCount: 5, receivedAt: '2026-07-27T01:00:00.000Z', status: 'VALID', qualityResults: [] };
    const first = await server.inject({ method: 'POST', url: '/contests/v1/source-snapshots', headers: command('OPS01'), payload: manifest });
    expect(first.statusCode).toBe(201); expect(first.json().sourceBatchId).toBe(manifest.sourceBatchId);
    const conflict = await server.inject({ method: 'POST', url: '/contests/v1/source-snapshots', headers: command('OPS01', { 'idempotency-key': 'source-conflict-0002' }), payload: { ...manifest, sha256: 'b'.repeat(64) } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('CON-4094');
  });

  it('orchestrates calculation runs without fabricating worker results', async () => {
    const server = app();
    const run = await server.inject({ method: 'POST', url: '/contests/v1/calculation-runs', headers: command('OPS01'), payload: { businessDate: '2026-07-27', agentMasterBatchId: 'agent-master-batch-001', productionBatchId: 'production-batch-001', reasonCode: 'SCHEDULED' } });
    expect(run.statusCode).toBe(202); expect(run.json()).toMatchObject({ status: 'WAITING_FOR_SOURCES', reconciliation: { eligible: 0, calculated: 0, succeeded: 0, failed: 0, quarantined: 0 } });
    const read = await server.inject({ url: `/contests/v1/calculation-runs/${run.json().runId}`, headers: H('OPS01') });
    expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({runId:run.json().runId,status:'WAITING_FOR_SOURCES',sourceLineage:{agentMasterBatchId:'agent-master-batch-001',productionBatchId:'production-batch-001'},reconciliation:{eligible:0,calculated:0,succeeded:0,failed:0,quarantined:0}});
    const missingResult=await server.inject({url:'/contests/v1/contests/contest_missing/agents/agent_missing/result',headers:H()});
    expect(missingResult.statusCode).toBe(404);expect(missingResult.json().code).toBe('CON-4041');
  });

  it('supports version diff, simulations, reusable assets and approval reads', async () => {
    const server = app();
    const created = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers: command(), payload: { code: 'OPS2026', nameKey: 'contest.ops', timezone: 'Asia/Kuala_Lumpur' } });
    const firstVersionId = created.json().latestVersionId;
    const cloned = await server.inject({ method: 'POST', url: `/contests/v1/contests/${created.json().contestId}/versions`, headers: command(), payload: { baseVersionId: firstVersionId, changeRationale: 'Add agency audience' } });
    expect(cloned.statusCode).toBe(201);
    await server.inject({ method: 'PATCH', url: `/contests/v1/contest-versions/${cloned.json().versionId}`, headers: H('A1001', { 'if-match': '"2"' }), payload: { audience: { channelCodes: ['AGENCY'] } } });
    const diff = await server.inject({ url: `/contests/v1/contest-versions/${cloned.json().versionId}/diff?againstVersionId=${firstVersionId}`, headers: H() });
    expect(diff.statusCode).toBe(200); expect(diff.json().changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/audience', operation: 'MODIFIED' })]));

    const clonedVersion = await server.inject({ url: `/contests/v1/contest-versions/${cloned.json().versionId}`, headers: H() });
    const simulation = await server.inject({ method: 'POST', url: `/contests/v1/contest-versions/${cloned.json().versionId}/simulations`, headers: command(), payload: { type: 'PORTFOLIO_IMPACT', versionChecksum: clonedVersion.json().checksum, sourceBusinessDate: '2026-07-27' } });
    expect(simulation.statusCode).toBe(202); expect(simulation.json()).toMatchObject({ type: 'SIMULATION', status: 'QUEUED' });
    const simulationRead = await server.inject({ url: `/contests/v1/simulations/${simulation.json().simulationId}`, headers: H() });
    expect(simulationRead.statusCode).toBe(200); expect(simulationRead.json().simulationId).toBe(simulation.json().simulationId);

    const rule = await server.inject({ method: 'POST', url: '/contests/v1/rules', headers: command(), payload: { code: 'FYP_RULE', name: 'FYP rule', nameKey: 'contest.rule.fyp', categoryCode: 'PRODUCTION', configuration: { nodeId: 'root_fyp_rule', type: 'ALL', children: [] } } });
    expect(rule.statusCode).toBe(201); expect(rule.json()).toMatchObject({ type: 'RULE', status: 'DRAFT' });

    const patched = await server.inject({ method: 'PATCH', url: `/contests/v1/contest-versions/${firstVersionId}`, headers: H('A1001', { 'if-match': '"1"' }), payload: { audience: { channels: [] }, qualification: { routes: [] }, calculation: { metrics: [] }, rewards: { tiers: [] }, governance: { stages: [] } } });
    const submitted = await server.inject({ method: 'POST', url: `/contests/v1/contest-versions/${firstVersionId}/submit`, headers: command('A1001', { 'if-match': patched.headers.etag! }), payload: { attested: true, changeRationale: 'Approval read test' } });
    const approvals = await server.inject({ url: '/contests/v1/approvals', headers: H() });
    const approval = await server.inject({ url: `/contests/v1/approvals/${submitted.json().approvalId}`, headers: H() });
    expect(approvals.statusCode).toBe(200); expect(approvals.json().items).toHaveLength(1);
    expect(approval.statusCode).toBe(200); expect(approval.json().approvalId).toBe(submitted.json().approvalId);
  });

  it('authors reusable rules with nested governed conditions and reloads the saved version (AC-CA-06-05, AC-RULE-02/04)', async () => {
    const server = app(); const createHeaders = command('A1001', { 'idempotency-key': 'create-editable-rule' });
    const created = await server.inject({ method: 'POST', url: '/contests/v1/rules', headers: createHeaders, payload: { code: 'ACTIVE_FYP', name: 'Active FYP', nameKey: 'contest.rule.activeFyp', categoryCode: 'ELIGIBILITY', configuration: { nodeId: 'root_active_fyp', type: 'ALL', children: [] } } });
    expect(created.statusCode).toBe(201); expect(created.json()).toMatchObject({ type: 'RULE', latestVersionId: expect.any(String) });
    const ruleVersionId = created.json().latestVersionId;
    const draft = await server.inject({ url: `/contests/v1/rule-versions/${ruleVersionId}`, headers: H() });
    expect(draft.statusCode).toBe(200); expect(draft.headers.etag).toBe('"1"');
    const expression = { nodeId: 'root_active_fyp', type: 'ALL', children: [
      { nodeId: 'active_status', type: 'PREDICATE', metricCode: 'AGENT_ACTIVE', operator: 'EQ', operand: { kind: 'BOOLEAN', value: true } },
      { nodeId: 'production_any', type: 'ANY', minimumPass: 1, children: [
        { nodeId: 'fyp_threshold', type: 'PREDICATE', metricCode: 'FYP', operator: 'GTE', operand: { kind: 'MONEY', value: '10000.00', currency: 'MYR' } },
        { nodeId: 'cases_threshold', type: 'PREDICATE', metricCode: 'CASE_COUNT', operator: 'GTE', operand: { kind: 'INTEGER', value: 5 } },
      ] },
    ] };
    const body = { expression, options: { periodMode: 'FULL_CAMPAIGN', unknownCodePolicy: 'BLOCK' } };
    const validation = await server.inject({ method: 'POST', url: `/contests/v1/rule-versions/${ruleVersionId}/validate`, headers: command('A1001', { 'idempotency-key': 'validate-editable-rule' }), payload: body });
    expect(validation.statusCode).toBe(200); expect(validation.json()).toMatchObject({ valid: true, nodeOutcomes: expect.arrayContaining([expect.objectContaining({ nodeId: 'fyp_threshold' })]) });
    const saved = await server.inject({ method: 'PATCH', url: `/contests/v1/rule-versions/${ruleVersionId}`, headers: command('A1001', { 'if-match': '"1"', 'idempotency-key': 'save-editable-rule' }), payload: body });
    expect(saved.statusCode).toBe(200); expect(saved.headers.etag).toBe('"2"');
    const reloaded = await server.inject({ url: `/contests/v1/rule-versions/${ruleVersionId}`, headers: H() });
    expect(reloaded.json().expression).toEqual(expression);
    const invalid = await server.inject({ method: 'PATCH', url: `/contests/v1/rule-versions/${ruleVersionId}`, headers: command('A1001', { 'if-match': '"2"', 'idempotency-key': 'invalid-editable-rule' }), payload: { ...body, expression: { ...expression, children: [{ nodeId: 'bad_metric_', type: 'PREDICATE', metricCode: 'NOT_ALLOWED', operator: 'GTE', operand: { kind: 'INTEGER', value: 1 } }] } } });
    expect(invalid.statusCode).toBe(422); expect(invalid.json().code).toBe('CON-4221');
  });

  it('persists command idempotency replay and rejects changed request hashes (D-CA-10, AC-C1-03)', async () => {
    const server = app(); const headers = command('A1001', { 'idempotency-key': 'stable-rule-command' });
    const payload = { code: 'IDEMPOTENT_RULE', name: 'Idempotent rule', nameKey: 'contest.rule.idempotent', categoryCode: 'QUALITY', configuration: { nodeId: 'root_idempotent', type: 'ALL', children: [] } };
    const first = await server.inject({ method: 'POST', url: '/contests/v1/rules', headers, payload });
    const replay = await server.inject({ method: 'POST', url: '/contests/v1/rules', headers, payload });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(201); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(first.json());
    const changed = await server.inject({ method: 'POST', url: '/contests/v1/rules', headers, payload: { ...payload, code: 'CHANGED_RULE' } });
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe('CON-4091');
  });

  it('applies idempotency to contest commands and atomically rolls back failed command writes', async () => {
    const server = app(); const headers = command('A1001', { 'idempotency-key': 'stable-contest-command' });
    const payload = { code: 'IDEM2026', nameKey: 'contest.idempotent', timezone: 'Asia/Kuala_Lumpur' };
    const first = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers, payload });
    const replay = await server.inject({ method: 'POST', url: '/contests/v1/contests', headers, payload });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(201); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(first.json());

    const repository = new SpecContestRepository(); const actor = { id: 'A1001', tenant: 'MY' };
    await expect(repository.idempotent('MY', 'createContest', 'rollback-command', payload, async () => {
      await repository.createContest(actor, payload);
      throw new Error('injected failure');
    })).rejects.toThrow('injected failure');
    expect((await repository.listContests('MY')).items).toHaveLength(0);
    const retried = await repository.idempotent('MY', 'createContest', 'rollback-command', payload, () => repository.createContest(actor, payload));
    expect(retried).toMatchObject({ kind: 'RESULT', replay: false });
    expect((await repository.listContests('MY')).items).toHaveLength(1);
  });

  it('enforces declared scopes and optional development entity/channel grants', async () => {
    const server = app();
    const deniedScope = await server.inject({ url: '/contests/v1/contests', headers: H('A1001', { 'x-scopes': 'contests:write' }) });
    expect(deniedScope.statusCode).toBe(403); expect(deniedScope.json().code).toBe('CON-4031');
    const allowedScope = await server.inject({ url: '/contests/v1/contests', headers: H('A1001', { 'x-scopes': 'contests:read' }) });
    expect(allowedScope.statusCode).toBe(200);
    const deniedEntity = await server.inject({ url: '/contests/v1/contests', headers: H('A1001', { 'x-entity-id': 'BRANCH-2', 'x-entity-grants': 'BRANCH-1' }) });
    expect(deniedEntity.statusCode).toBe(403); expect(deniedEntity.json().code).toBe('CON-4031');
    const deniedChannel = await server.inject({ url: '/contests/v1/contests', headers: H('A1001', { 'x-channel-code': 'AGENCY', 'x-channel-grants': 'BANCA' }) });
    expect(deniedChannel.statusCode).toBe(403); expect(deniedChannel.json().code).toBe('CON-4031');
  });
});