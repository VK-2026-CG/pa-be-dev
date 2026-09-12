import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { createSpecContestRepository } from '../src/contest/spec-repository.js';
import { BFF } from './support/bff-api.js';
import { buildMultipart } from './support/multipart.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine

const CA = `${BFF}/contest-admin`;
const app = buildApp(await createSource(), await createSpecContestRepository());

/** Sequential/stateful, like the original Playwright `test.describe.serial` block — each test builds on the previous one's backend state. */
describe('Contest Administration BFF — real Contest domain', () => {
  let contestId = ''; let versionId = ''; let versionUrl = ''; let approvalId = '';

  it('(AC-CA-01) create is persisted and idempotently replayed by the Contest domain', async () => {
    const data = { code: 'MY_CREATE_API', nameKey: 'contest.created.new', timezone: 'Asia/Kuala_Lumpur' };
    const noKey = await app.inject({ method: 'POST', url: `${CA}/contests`, payload: data });
    expect(noKey.statusCode).toBe(422);

    const headers = { 'idempotency-key': 'create-api-test-key' };
    const first = await app.inject({ method: 'POST', url: `${CA}/contests`, headers, payload: data });
    const replay = await app.inject({ method: 'POST', url: `${CA}/contests`, headers, payload: data });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const created = first.json();
    contestId = created.contestId; versionId = created.latestVersionId;
    versionUrl = `${CA}/contests/${contestId}/versions/${versionId}`;
    expect(contestId).toMatch(/^contest_/); expect(versionId).toMatch(/^version_/);
  });

  it('(AC-CA-01-01/03) portfolio composes backend list and overview', async () => {
    const response = await app.inject({ url: `${CA}/portfolio?status=DRAFT&query=MY_CREATE_API` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.contests).toEqual([expect.objectContaining({ contestId, code: 'MY_CREATE_API', nameKey: 'contest.created.new' })]);
    expect(body.metrics).toContainEqual({ code: 'TOTAL_CONTESTS', value: 7 });
  });

  it('(AC-CA-02-02) stale ETag is rejected and current ETag advances backend revision', async () => {
    const stale = await app.inject({ method: 'PATCH', url: versionUrl, headers: { 'if-match': '"999"' }, payload: { configuration: { basics: { timezone: 'UTC' } } } });
    expect(stale.statusCode).toBe(412); expect(stale.json().code).toBe('CON-4121');
    const before = (await app.inject({ url: versionUrl })).json();
    const saved = await app.inject({
      method: 'PATCH', url: versionUrl, headers: { 'if-match': before.etag },
      payload: { configuration: { basics: { code: 'MY_CREATE_API', nameKey: 'contest.created.new', country: 'MY', timezone: 'Asia/Kuala_Lumpur', name: 'New contest' }, audience: { codes: ['PERSONAL'] }, calculation: { metricCode: 'FYP' }, rewards: { precedenceCode: 'HIGHEST_ONLY' }, governance: { frequencyCode: 'DAILY' } } },
    });
    expect(saved.statusCode).toBeLessThan(300);
    expect(saved.json().revision).toBe(before.revision + 1);
  });

  it('(AC-CA-ROUTE-01/02) qualification route is persisted through contest-version PATCH', async () => {
    const current = (await app.inject({ url: versionUrl })).json();
    const response = await app.inject({
      method: 'POST', url: `${versionUrl}/routes`, headers: { 'idempotency-key': 'route-create-key' },
      payload: { name: 'Personal production gate', code: 'PERSONAL_GATE', audienceCode: 'PERSONAL', rootType: 'ALL', tierCode: 'SILVER', rewardCode: 'STAR_1', periodMode: 'FULL_CAMPAIGN', etag: current.etag },
    });
    expect(response.statusCode).toBe(201);
    const route = response.json();
    expect(route).toMatchObject({ routeId: 'route_personal_gate', expression: { type: 'ALL' } });

    const editorUrl = `${versionUrl}/rules/${route.routeId}`;
    const editor = (await app.inject({ url: editorUrl })).json();
    const expression = { ...editor.expression, children: [{ nodeId: 'fyp_gate', type: 'PREDICATE', metricCode: 'FYP', operator: 'GTE', operand: { kind: 'MONEY', value: '25000.00', currency: 'MYR' } }] };
    const saved = await app.inject({ method: 'PATCH', url: editorUrl, payload: { expression, options: editor.options, etag: editor.etag } });
    expect(saved.statusCode).toBeLessThan(300);
    expect((await app.inject({ url: versionUrl })).json().configuration.qualification.routes[0].expression).toEqual(expression);
  });

  it('(AC-CA-04) review invokes backend validation and reports a valid complete draft', async () => {
    const review = await app.inject({ url: `${versionUrl}/review` });
    expect(review.statusCode).toBeLessThan(300);
    const body = review.json();
    expect(body).toMatchObject({ versionId, contest: { contestId }, validation: { blocking: false } });
    expect(body.checksum).toBeTruthy();
  });

  it('(AC-CA-BROCHURE-01/02) PDF brochure upload persists privately and streams through the BFF', async () => {
    const current = (await app.inject({ url: versionUrl })).json();
    const pdf = Buffer.from('%PDF-1.7\nprivate contest brochure\n%%EOF');
    const { contentType, body } = buildMultipart({}, { fieldName: 'file', fileName: 'contest-brochure.pdf', contentType: 'application/pdf', buffer: pdf });
    const upload = await app.inject({
      method: 'PUT', url: `${versionUrl}/brochure`,
      headers: { 'if-match': current.etag, 'idempotency-key': 'brochure-api-key', 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ fileName: 'contest-brochure.pdf', mediaType: 'application/pdf', status: 'AVAILABLE' });

    const download = await app.inject({ url: `${versionUrl}/brochure` });
    expect(download.statusCode).toBeLessThan(300);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload).toEqual(pdf);

    const reloaded = (await app.inject({ url: versionUrl })).json();
    expect(reloaded.brochure).toMatchObject({ fileName: 'contest-brochure.pdf', status: 'AVAILABLE' });
  });

  it('(AC-CA-05-01) simulation command and poll read backend-owned job state', async () => {
    const review = (await app.inject({ url: `${versionUrl}/review` })).json();
    const url = `${versionUrl}/simulations`;
    const started = await app.inject({ method: 'POST', url, headers: { 'idempotency-key': 'simulation-api-key' }, payload: { type: 'PORTFOLIO_IMPACT', versionChecksum: review.checksum } });
    expect(started.statusCode).toBe(202);
    const startBody = started.json();
    expect(startBody.simulation).toMatchObject({ status: 'QUEUED', type: 'PORTFOLIO_IMPACT' });
    const polled = (await app.inject({ url })).json();
    expect(polled.simulation.jobId).toBe(startBody.simulation.jobId);
  });

  it('(AC-CA-07) submit creates a backend approval and checker decision is persisted', async () => {
    const current = (await app.inject({ url: versionUrl })).json();
    const submitted = await app.inject({
      method: 'POST', url: `${versionUrl}/submit`, headers: { 'if-match': current.etag, 'idempotency-key': 'submit-api-key' },
      payload: { attested: true, changeRationale: 'Ready for governed approval' },
    });
    expect(submitted.statusCode).toBe(201);
    approvalId = submitted.json().approvalId;

    const inbox = (await app.inject({ url: `${CA}/approvals?inbox=ASSIGNED` })).json();
    expect(inbox.items).toEqual(expect.arrayContaining([expect.objectContaining({ approvalId, versionId })]));

    const maker = await app.inject({
      method: 'POST', url: `${CA}/approvals/${approvalId}/decisions`,
      headers: { 'x-contest-actor': 'A1001', 'if-match': '"1"', 'idempotency-key': 'maker-decision-key' },
      payload: { decision: 'APPROVE' },
    });
    expect(maker.statusCode).toBe(403);

    const checker = await app.inject({
      method: 'POST', url: `${CA}/approvals/${approvalId}/decisions`,
      headers: { 'x-contest-actor': 'A2001', 'if-match': '"1"', 'idempotency-key': 'checker-decision-key' },
      payload: { decision: 'APPROVE' },
    });
    expect(checker.statusCode).toBeLessThan(300);
    expect(checker.json().status).toBe('APPROVED');
  });

  it('(AC-CA-08-01) audit screen reads domain events; unsupported export fails explicitly', async () => {
    const audit = (await app.inject({ url: `${CA}/audit` })).json();
    expect(audit.items.map((item: { action: string }) => item.action)).toEqual(expect.arrayContaining(['CONTEST_CREATED', 'CONTEST_VERSION_UPDATED', 'SIMULATION_STARTED', 'CONTEST_VERSION_SUBMITTED', 'APPROVAL_APPROVE']));
    const exportRes = await app.inject({ method: 'POST', url: `${CA}/audit/exports`, headers: { 'idempotency-key': 'audit-export-key' } });
    expect(exportRes.statusCode).toBe(501);
  });

  it('(AC-CA-HIST-01) historic list is backend-owned and the transitional Template BFF is removed', async () => {
    const historic = await app.inject({ url: `${CA}/historic-contests` });
    expect(historic.statusCode).toBeLessThan(300);
    expect(historic.json().items).toEqual([]);
    expect((await app.inject({ url: `${CA}/templates` })).statusCode).toBe(404);
  });

  it('(AC-CA-AI-01/02/03/04) brochure bytes create a complete review-required draft through the BFF', async () => {
    const code = `AI_API_${Date.now()}`;
    const pdf = Buffer.from('%PDF-1.7\nsynthetic contest brochure\n%%EOF');
    const { contentType, body } = buildMultipart({ requestedCode: code }, { fieldName: 'file', fileName: 'contest.pdf', contentType: 'application/pdf', buffer: pdf });
    const response = await app.inject({
      method: 'POST', url: `${CA}/contest-imports`,
      headers: { 'idempotency-key': `ai-import-${Date.now()}`, 'content-type': contentType },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    const started = response.json();
    expect(started).toMatchObject({ status: 'QUEUED', statusNav: { route: expect.stringContaining('/contest-admin/contest-imports/') } });

    let current;
    for (let index = 0; index < 30; index++) {
      current = (await app.inject({ url: `${CA}/contest-imports/${started.importId}` })).json();
      if (current.status === 'COMPLETED') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(current).toMatchObject({ status: 'COMPLETED', result: { status: 'DRAFT', reviewState: 'NEEDS_BUSINESS_REVIEW', nav: { route: expect.stringContaining('/edit/BASICS') } } });
    expect(JSON.stringify(current)).not.toContain('objectKey');

    const builder = (await app.inject({ url: `${CA}/contests/${current!.result.contestId}/versions/${current!.result.versionId}` })).json();
    expect(builder.configuration.qualification.routes[0].expression).toMatchObject({ type: 'ALL', children: [{ type: 'PREDICATE', metricCode: 'FYP' }] });

    const brochure = await app.inject({ url: `${CA}/contests/${current!.result.contestId}/versions/${current!.result.versionId}/brochure` });
    expect(brochure.rawPayload).toEqual(pdf);
  });

  it('(AC-CA-06-01/05) reusable rule round-trip reaches backend', async () => {
    const url = `${CA}/rules`;
    const data = { name: 'High quality production', code: 'HIGH_QUALITY_PRODUCTION', categoryCode: 'QUALITY', rootType: 'ALL' };
    const headers = { 'idempotency-key': 'create-rule-api-key' };
    const first = await app.inject({ method: 'POST', url, headers, payload: data });
    const replay = await app.inject({ method: 'POST', url, headers, payload: data });
    expect(first.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const created = first.json();
    const editorUrl = `${url}/${created.assetId}/versions/${created.latestVersionId}`;
    const editor = (await app.inject({ url: editorUrl })).json();
    const expression = { nodeId: editor.expression.nodeId, type: 'ALL', children: [{ nodeId: 'api_fyp_condition', type: 'PREDICATE', metricCode: 'FYP', operator: 'GTE', operand: { kind: 'MONEY', value: '25000.00', currency: 'MYR' } }] };
    const tested = await app.inject({ method: 'POST', url: `${editorUrl}/test`, headers: { 'idempotency-key': 'test-rule-api-key' }, payload: { expression, options: editor.options } });
    expect(tested.statusCode).toBeLessThan(300);
    const saved = await app.inject({ method: 'PATCH', url: editorUrl, headers: { 'idempotency-key': 'save-rule-api-key' }, payload: { expression, options: editor.options, etag: editor.etag } });
    expect(saved.statusCode).toBeLessThan(300);
    const reloaded = (await app.inject({ url: editorUrl })).json();
    expect(reloaded).toMatchObject({ expression, etag: '"2"' });
  });
});
