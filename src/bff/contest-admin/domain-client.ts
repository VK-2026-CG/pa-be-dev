/**
 * Contest domain client — the BFF and the Contest Admin domain area
 * (`src/contest/*`, mounted at `/contests/v1`) now run in the same Fastify
 * process. Rather than reimplement the idempotency/ETag/principal-auth logic
 * that already lives inline in `src/contest/spec-routes.ts`, this calls back
 * into the same Fastify app via `app.inject()` — Fastify's own in-process
 * request mechanism (no real socket, works identically under test and in
 * production). Shape mirrors the former HTTP client 1:1 so
 * `contest-service.ts` / `rule-service.ts` needed no further changes.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ApprovalDecisionRequestVM, ArchiveContestResultVM, BrochureMetadataVM, CreateContestRequestVM, HistoricContestSummaryVM, ReactivateContestRequestVM, RuleExpressionVM, RuleOptionsVM, StartSimulationRequestVM, SubmitContestRequestVM } from '../../../vendor/spec/contest-admin-vm.js';

let appRef: FastifyInstance | undefined;

/** Wire up the domain client to the running app. Called once from `registerBffRoutes`. */
export function initContestDomainClient(app: FastifyInstance): void { appRef = app; }

function app(): FastifyInstance {
  if (!appRef) throw new Error('Contest domain client used before initContestDomainClient()');
  return appRef;
}

export class ContestDomainError extends Error {
  constructor(public status: number, public problem: { status: number; code: string; title: string; traceId: string; detail?: string; errors?: Array<{ path: string; code: string; messageKey?: string }> }) { super(problem.code); }
}
export interface ContestIdentity { actorId: string; tenant: string }
const defaultIdentity: ContestIdentity = { actorId: 'A1001', tenant: 'MY' };

function firstHeader(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : String(value);
}

function parseJson(payload: string): Record<string, any> {
  if (!payload) return {};
  try { return JSON.parse(payload) as Record<string, any>; } catch { return {}; }
}

async function call<T>(
  method: InjectOptions['method'], path: string, identity: ContestIdentity = defaultIdentity,
  init?: { headers?: Record<string, string>; body?: string },
): Promise<{ body: T; etag?: string; replay: boolean }> {
  const response = await app().inject({
    method, url: `/contests/v1${path}`,
    headers: { 'content-type': 'application/json', 'x-agent-id': identity.actorId, 'x-tenant': identity.tenant, ...(init?.headers ?? {}) },
    payload: init?.body,
  });
  const body = parseJson(response.payload);
  if (response.statusCode >= 400) {
    throw new ContestDomainError(response.statusCode, {
      status: response.statusCode, code: body.code ?? 'CON-5031', title: body.title ?? 'Unknown error',
      traceId: body.traceId ?? 'unavailable', detail: body.detail, errors: body.errors,
    });
  }
  return { body: body as T, etag: firstHeader(response.headers.etag), replay: firstHeader(response.headers['idempotent-replay']) === 'true' };
}

export interface DomainRuleSummary { assetId: string; code: string; name: string; nameKey?: string; type: 'RULE'; categoryCode: string; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'DEPRECATED'; latestVersion: string; latestVersionId: string; adoptionCount: number }
export interface DomainRuleVersion { assetId: string; ruleVersionId: string; revision: number; code: string; name: string; nameKey?: string; categoryCode: string; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED' | 'DEPRECATED'; expression: RuleExpressionVM; options: RuleOptionsVM; checksum: string; catalogueVersion: string; createdBy: string; createdAt: string; updatedAt?: string }
export interface DomainRuleReport { valid: boolean; issues: Array<{ path: string; code: string; messageKey?: string }>; nodeOutcomes: Array<{ nodeId: string; outcome: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_EVALUATED'; reasonCode?: string }>; configurationChecksum: string; engineVersion: string; catalogueVersion: string }
export interface DomainContestSummary { contestId: string; code: string; nameKey: string; status: string; ownerRef: string; campaignStart: string; campaignEnd: string; audienceCodes: string[]; ruleCount: number; updatedAt: string; latestVersionId?: string; country?: string; timezone?: string }
export interface DomainContestVersion { versionId: string; contestId: string; revision: number; displayVersion: string; status: string; configuration: Record<string, unknown>; checksum: string; createdBy: string; createdAt: string; updatedAt?: string; baseVersionId?: string; brochure?: BrochureMetadataVM }
export interface DomainValidation { validationRunId: string; status: 'VALID' | 'INVALID'; issues: Array<{ path: string; code: string; severity: string; messageKey?: string }>; validatedAt: string; configurationChecksum: string }
export interface DomainApproval { approvalId: string; contestId: string; versionId: string; revision: number; status: string; submittedBy: string; submittedAt: string; snapshotChecksum: string; stages: Array<{ stageId: string; status: string }>; decidedAt?: string; decision?: string; returnedVersionId?: string }
export interface DomainSimulation { simulationId: string; jobId: string; versionId: string; simulationType: 'SAMPLE_PARTICIPANT' | 'PORTFOLIO_IMPACT'; status: string; progressPct: number; reconciliation?: Record<string, number>; problemCode?: string }
export interface DomainAsset { assetId: string; code: string; name?: string; type: 'RULE'; categoryCode: string; status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'DEPRECATED'; latestVersion: string; latestVersionId: string; adoptionCount: number }
export interface DomainAuditEvent { eventId: string; occurredAt: string; actorRef: string; action: string; resourceType: string; resourceId: string; outcome: string; versionId?: string }
export const contestDomain = {
  listContests: (search = '', identity?: ContestIdentity) => call<{ items: DomainContestSummary[]; page: { hasMore: boolean; count: number } }>('GET', `/contests${search}`, identity),
  overview: (identity?: ContestIdentity) => call<{ metrics: Array<{ code: string; value: number }>; attentionItems: Array<{ id: string; type: string; severity: 'INFO' | 'WARNING' | 'ERROR' }> }>('GET', '/contests/overview', identity),
  createContest: (input: CreateContestRequestVM, key: string, identity?: ContestIdentity) => call<DomainContestSummary>('POST', '/contests', identity, { headers: { 'idempotency-key': key }, body: JSON.stringify(input) }),
  getContest: (contestId: string, identity?: ContestIdentity) => call<DomainContestSummary>('GET', `/contests/${encodeURIComponent(contestId)}`, identity),
  getContestVersion: (versionId: string, identity?: ContestIdentity) => call<DomainContestVersion>('GET', `/contest-versions/${encodeURIComponent(versionId)}`, identity),
  patchContestVersion: (versionId: string, configuration: Record<string, unknown>, etag: string, identity?: ContestIdentity) => call<DomainContestVersion>('PATCH', `/contest-versions/${encodeURIComponent(versionId)}`, identity, { headers: { 'if-match': etag }, body: JSON.stringify(configuration) }),
  validateContestVersion: (versionId: string, key: string, identity?: ContestIdentity) => call<DomainValidation>('POST', `/contest-versions/${encodeURIComponent(versionId)}/validate`, identity, { headers: { 'idempotency-key': key }, body: '{}' }),
  submitContestVersion: (versionId: string, input: SubmitContestRequestVM, etag: string, key: string, identity?: ContestIdentity) => call<DomainApproval>('POST', `/contest-versions/${encodeURIComponent(versionId)}/submit`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
  listHistoric: (search = '', identity?: ContestIdentity) => call<{ items: HistoricContestSummaryVM[]; page: { hasMore: boolean; count: number } }>('GET', `/historic-contests${search}`, identity),
  archiveContest: (contestId: string, etag: string, key: string, identity?: ContestIdentity) => call<ArchiveContestResultVM>('DELETE', `/contests/${encodeURIComponent(contestId)}`, identity, { headers: { 'if-match': etag, 'idempotency-key': key } }),
  reactivateContest: (contestId: string, input: ReactivateContestRequestVM, etag: string, key: string, identity?: ContestIdentity) => call<DomainContestVersion>('POST', `/contests/${encodeURIComponent(contestId)}/reactivations`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
  listApprovals: (status: string | undefined, identity?: ContestIdentity) => call<{ items: DomainApproval[]; page: { hasMore: boolean; count: number } }>('GET', `/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`, identity),
  decideApproval: (approvalId: string, input: ApprovalDecisionRequestVM, etag: string, key: string, identity?: ContestIdentity) => call<DomainApproval>('POST', `/approvals/${encodeURIComponent(approvalId)}/decisions`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
  startSimulation: (versionId: string, input: StartSimulationRequestVM, key: string, identity?: ContestIdentity) => call<DomainSimulation>('POST', `/contest-versions/${encodeURIComponent(versionId)}/simulations`, identity, { headers: { 'idempotency-key': key }, body: JSON.stringify(input) }),
  getSimulation: (simulationId: string, identity?: ContestIdentity) => call<DomainSimulation>('GET', `/simulations/${encodeURIComponent(simulationId)}`, identity),
  listAudit: (identity?: ContestIdentity) => call<{ items: DomainAuditEvent[]; page: { hasMore: boolean; count: number } }>('GET', '/audit-events', identity),
  listRules: (identity?: ContestIdentity) => call<{ items: DomainRuleSummary[] }>('GET', '/rules', identity),
  createRule: (input: { code: string; name: string; categoryCode: string; configuration: RuleExpressionVM }, idempotencyKey: string, identity?: ContestIdentity) => call<DomainRuleSummary>('POST', '/rules', identity, { headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
  getRuleVersion: (ruleVersionId: string, identity?: ContestIdentity) => call<DomainRuleVersion>('GET', `/rule-versions/${encodeURIComponent(ruleVersionId)}`, identity),
  patchRuleVersion: (ruleVersionId: string, input: { expression: RuleExpressionVM; options: RuleOptionsVM }, etag: string, idempotencyKey: string, identity?: ContestIdentity) => call<DomainRuleVersion>('PATCH', `/rule-versions/${encodeURIComponent(ruleVersionId)}`, identity, { headers: { 'if-match': etag, 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
  validateRuleVersion: (ruleVersionId: string, input: { expression: RuleExpressionVM; options: RuleOptionsVM }, idempotencyKey: string, identity?: ContestIdentity) => call<DomainRuleReport>('POST', `/rule-versions/${encodeURIComponent(ruleVersionId)}/validate`, identity, { headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
  getContestImport: (importId: string, identity?: ContestIdentity) => call<Record<string, unknown>>('GET', `/contest-imports/${encodeURIComponent(importId)}`, identity),
};

/**
 * Binary proxy call for brochure/import endpoints — forwards a raw
 * multipart/form-data (or empty GET) request into the same `/contests/v1`
 * routes and returns the raw injected response so the BFF route can relay
 * status/headers/bytes unchanged (mirrors the former `brochureCall` HTTP proxy).
 */
export async function injectBinary(
  method: InjectOptions['method'], path: string, identity: ContestIdentity = defaultIdentity,
  init?: { headers?: Record<string, string>; payload?: Buffer },
) {
  const response = await app().inject({
    method, url: `/contests/v1${path}`,
    headers: { 'x-agent-id': identity.actorId, 'x-tenant': identity.tenant, ...(init?.headers ?? {}) },
    payload: init?.payload,
  });
  if (response.statusCode >= 400) {
    const body = parseJson(response.payload);
    throw new ContestDomainError(response.statusCode, {
      status: response.statusCode, code: body.code ?? 'CON-5031', title: body.title ?? 'Unknown error', traceId: body.traceId ?? 'unavailable',
    });
  }
  return response;
}
