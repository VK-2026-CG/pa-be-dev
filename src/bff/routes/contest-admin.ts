import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApprovalDecisionRequestVM, CreateContestRequestVM, CreateQualificationRouteRequestVM, CreateRuleAssetRequestVM,
  ReactivateContestRequestVM, SaveRuleRequestVM, StartSimulationRequestVM, SubmitContestRequestVM, TestRuleRequestVM,
} from '../../../vendor/spec/contest-admin-vm.js';
import {
  approvals, archive, audit, builder, contestImport, createContest, createQualificationRoute, decide,
  getEmbeddedRule, historicContests, patchBuilder, pollSimulation, portfolio, reactivate, review,
  saveEmbeddedRule, startSimulation, submit, testEmbeddedRule,
} from '../contest-admin/contest-service.js';
import { createRule, getRuleEditor, listRules, saveRule, testRule } from '../contest-admin/rule-service.js';
import { contestAsyncResponse, readRawBody, requireIdempotencyKey } from '../contest-admin/http.js';
import { ContestDomainError, injectBinary, type ContestIdentity } from '../contest-admin/domain-client.js';

const PREFIX = '/api/bff/v1/contest-admin';

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The `x-contest-actor`/`x-contest-tenant` header pair (unverified, mirrors the pre-migration fe behavior exactly — most routes below don't read it and fall back to the domain client's own default identity). */
function contestActorIdentity(req: FastifyRequest, fallbackActor: string): ContestIdentity {
  return { actorId: header(req, 'x-contest-actor') ?? fallbackActor, tenant: header(req, 'x-contest-tenant') ?? 'MY' };
}

export function registerContestAdminRoutes(app: FastifyInstance): void {
  app.get(`${PREFIX}/portfolio`, async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    await contestAsyncResponse(reply, () => portfolio(new URLSearchParams(req.query as Record<string, string>)));
  });

  app.post(`${PREFIX}/contests`, async (req: FastifyRequest<{ Body: CreateContestRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-contest-create')) return;
    await contestAsyncResponse(reply, () => createContest(req.body, key), 201);
  });

  app.get(`${PREFIX}/historic-contests`, async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    await contestAsyncResponse(reply, () => historicContests(new URLSearchParams(req.query as Record<string, string>)));
  });

  app.get(`${PREFIX}/contests/:contestId/versions/:versionId`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => builder(req.params.contestId, req.params.versionId));
  });

  app.patch(`${PREFIX}/contests/:contestId/versions/:versionId`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string }; Body: { configuration?: Record<string, unknown> } }>, reply) => {
    await contestAsyncResponse(reply, () => patchBuilder(req.params.contestId, req.params.versionId, req.body.configuration ?? {}, header(req, 'if-match') ?? ''));
  });

  app.get(`${PREFIX}/contests/:contestId/versions/:versionId/review`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => review(req.params.contestId, req.params.versionId));
  });

  app.post(`${PREFIX}/contests/:contestId/versions/:versionId/routes`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string }; Body: CreateQualificationRouteRequestVM }>, reply) => {
    await contestAsyncResponse(reply, () => createQualificationRoute(req.params.contestId, req.params.versionId, req.body), 201);
  });

  app.get(`${PREFIX}/contests/:contestId/versions/:versionId/rules/:ruleId`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string; ruleId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => getEmbeddedRule(req.params.contestId, req.params.versionId, req.params.ruleId));
  });

  app.patch(`${PREFIX}/contests/:contestId/versions/:versionId/rules/:ruleId`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string; ruleId: string }; Body: SaveRuleRequestVM }>, reply) => {
    await contestAsyncResponse(reply, () => saveEmbeddedRule(req.params.contestId, req.params.versionId, req.params.ruleId, req.body));
  });

  app.post(`${PREFIX}/contests/:contestId/versions/:versionId/rules/:ruleId/test`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string; ruleId: string }; Body: SaveRuleRequestVM }>, reply) => {
    await contestAsyncResponse(reply, () => testEmbeddedRule(req.params.contestId, req.params.versionId, req.params.ruleId, req.body));
  });

  app.get(`${PREFIX}/contests/:contestId/versions/:versionId/simulations`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => pollSimulation(req.params.contestId, req.params.versionId));
  });

  app.post(`${PREFIX}/contests/:contestId/versions/:versionId/simulations`, async (req: FastifyRequest<{ Params: { contestId: string; versionId: string }; Body: StartSimulationRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-simulation')) return;
    await contestAsyncResponse(reply, () => startSimulation(req.params.contestId, req.params.versionId, req.body, key), 202);
  });

  app.post(`${PREFIX}/contests/:contestId/versions/:versionId/submit`, async (req: FastifyRequest<{ Params: { versionId: string }; Body: SubmitContestRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-submit')) return;
    await contestAsyncResponse(reply, () => submit(req.params.versionId, req.body, header(req, 'if-match') ?? '', key), 201);
  });

  app.post(`${PREFIX}/contests/:contestId/reactivations`, async (req: FastifyRequest<{ Params: { contestId: string }; Body: ReactivateContestRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-reactivate')) return;
    await contestAsyncResponse(reply, () => reactivate(req.params.contestId, req.body, header(req, 'if-match') ?? '', key), 201);
  });

  app.delete(`${PREFIX}/contests/:contestId`, async (req: FastifyRequest<{ Params: { contestId: string } }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-archive')) return;
    await contestAsyncResponse(reply, () => archive(req.params.contestId, header(req, 'if-match') ?? '', key));
  });

  app.get(`${PREFIX}/approvals`, async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, reply) => {
    await contestAsyncResponse(reply, () => approvals(req.query.inbox));
  });

  app.post(`${PREFIX}/approvals/:approvalId/decisions`, async (req: FastifyRequest<{ Params: { approvalId: string }; Body: ApprovalDecisionRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-decision')) return;
    const identity = contestActorIdentity(req, 'A2001');
    await contestAsyncResponse(reply, () => decide(req.params.approvalId, req.body, header(req, 'if-match') ?? '', key, identity));
  });

  app.get(`${PREFIX}/audit`, async (_req, reply) => {
    await contestAsyncResponse(reply, () => audit());
  });

  app.post(`${PREFIX}/audit/exports`, async (_req, reply) => {
    reply.status(501).send({ status: 501, code: 'CON-5011', messageKey: 'contest.error.generic', traceId: 'audit-export-not-in-domain-contract' });
  });

  app.get(`${PREFIX}/contest-imports/:importId`, async (req: FastifyRequest<{ Params: { importId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => contestImport(req.params.importId, contestActorIdentity(req, 'A1001')));
  });

  app.get(`${PREFIX}/rules`, async (req, reply) => {
    await contestAsyncResponse(reply, () => listRules(contestActorIdentity(req, 'A1001')));
  });

  app.post(`${PREFIX}/rules`, async (req: FastifyRequest<{ Body: CreateRuleAssetRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-rule-create')) return;
    await contestAsyncResponse(reply, () => createRule(req.body, key, contestActorIdentity(req, 'A1001')), 201);
  });

  app.get(`${PREFIX}/rules/:assetId/versions/:ruleVersionId`, async (req: FastifyRequest<{ Params: { assetId: string; ruleVersionId: string } }>, reply) => {
    await contestAsyncResponse(reply, () => getRuleEditor(req.params.assetId, req.params.ruleVersionId, contestActorIdentity(req, 'A1001')));
  });

  app.patch(`${PREFIX}/rules/:assetId/versions/:ruleVersionId`, async (req: FastifyRequest<{ Params: { assetId: string; ruleVersionId: string }; Body: SaveRuleRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-rule-save')) return;
    await contestAsyncResponse(reply, () => saveRule(req.params.assetId, req.params.ruleVersionId, req.body, key, contestActorIdentity(req, 'A1001')));
  });

  app.post(`${PREFIX}/rules/:assetId/versions/:ruleVersionId/test`, async (req: FastifyRequest<{ Params: { assetId: string; ruleVersionId: string }; Body: TestRuleRequestVM }>, reply) => {
    const key = header(req, 'idempotency-key');
    if (!requireIdempotencyKey(reply, key, 'bff-rule-test')) return;
    await contestAsyncResponse(reply, () => testRule(req.params.assetId, req.params.ruleVersionId, req.body, key, contestActorIdentity(req, 'A1001')));
  });

  /** AI brochure import — proxies the raw multipart upload into the internal `/contests/v1/contest-imports` route. */
  app.post(`${PREFIX}/contest-imports`, async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = contestActorIdentity(req, 'A1001');
    const bytes = await readRawBody(req);
    try {
      const response = await injectBinary('POST', '/contest-imports', identity, {
        headers: {
          'content-type': header(req, 'content-type') ?? 'application/octet-stream',
          'idempotency-key': header(req, 'idempotency-key') ?? '',
        },
        payload: bytes,
      });
      const body = JSON.parse(response.payload || '{}') as Record<string, unknown>;
      reply
        .header('location', `${PREFIX}/contest-imports/${body.importId as string}`)
        .header('retry-after', (Array.isArray(response.headers['retry-after']) ? response.headers['retry-after'][0] : response.headers['retry-after']) ?? '1')
        .status(response.statusCode)
        .send({ ...body, statusNav: { route: `/contest-admin/contest-imports/${body.importId as string}` } });
    } catch (error) {
      if (error instanceof ContestDomainError) {
        const messageKey = error.problem.code === 'CON-4151' ? 'contest.error.importInvalidPdf' : error.problem.code === 'CON-4131' ? 'contest.error.importTooLarge' : 'contest.error.generic';
        reply.status(error.status).send({ status: error.status, code: error.problem.code, messageKey, traceId: error.problem.traceId });
        return;
      }
      throw error;
    }
  });

  /** Brochure upload/download — raw byte proxy into `/contests/v1/contest-versions/:versionId/brochure` (unwrapped: matches the former fe proxy, which let a failed upstream call surface as a 500 rather than a shaped error). */
  app.put(`${PREFIX}/contests/:contestId/versions/:versionId/brochure`, async (req: FastifyRequest<{ Params: { versionId: string } }>, reply) => {
    const identity = contestActorIdentity(req, 'A1001');
    const bytes = await readRawBody(req);
    const response = await injectBinary('PUT', `/contest-versions/${encodeURIComponent(req.params.versionId)}/brochure`, identity, {
      headers: {
        'content-type': header(req, 'content-type') ?? 'application/octet-stream',
        'if-match': header(req, 'if-match') ?? '',
        'idempotency-key': header(req, 'idempotency-key') ?? '',
      },
      payload: bytes,
    });
    reply.status(response.statusCode).send(JSON.parse(response.payload || '{}'));
  });

  app.get(`${PREFIX}/contests/:contestId/versions/:versionId/brochure`, async (req: FastifyRequest<{ Params: { versionId: string } }>, reply) => {
    const identity = contestActorIdentity(req, 'A1001');
    const response = await injectBinary('GET', `/contest-versions/${encodeURIComponent(req.params.versionId)}/brochure`, identity);
    for (const name of ['content-type', 'content-length', 'content-disposition', 'etag', 'x-content-type-options']) {
      const value = response.headers[name];
      if (value) reply.header(name, Array.isArray(value) ? value[0]! : value);
    }
    reply.status(response.statusCode).send(response.rawPayload);
  });
}
