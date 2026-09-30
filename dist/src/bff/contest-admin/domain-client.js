let appRef;
/** Wire up the domain client to the running app. Called once from `registerBffRoutes`. */
export function initContestDomainClient(app) { appRef = app; }
function app() {
    if (!appRef)
        throw new Error('Contest domain client used before initContestDomainClient()');
    return appRef;
}
export class ContestDomainError extends Error {
    status;
    problem;
    constructor(status, problem) {
        super(problem.code);
        this.status = status;
        this.problem = problem;
    }
}
const defaultIdentity = { actorId: 'A1001', tenant: 'MY' };
function firstHeader(value) {
    if (value === undefined)
        return undefined;
    return Array.isArray(value) ? value[0] : String(value);
}
function parseJson(payload) {
    if (!payload)
        return {};
    try {
        return JSON.parse(payload);
    }
    catch {
        return {};
    }
}
async function call(method, path, identity = defaultIdentity, init) {
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
    return { body: body, etag: firstHeader(response.headers.etag), replay: firstHeader(response.headers['idempotent-replay']) === 'true' };
}
export const contestDomain = {
    listContests: (search = '', identity) => call('GET', `/contests${search}`, identity),
    overview: (identity) => call('GET', '/contests/overview', identity),
    createContest: (input, key, identity) => call('POST', '/contests', identity, { headers: { 'idempotency-key': key }, body: JSON.stringify(input) }),
    getContest: (contestId, identity) => call('GET', `/contests/${encodeURIComponent(contestId)}`, identity),
    getContestVersion: (versionId, identity) => call('GET', `/contest-versions/${encodeURIComponent(versionId)}`, identity),
    patchContestVersion: (versionId, configuration, etag, identity) => call('PATCH', `/contest-versions/${encodeURIComponent(versionId)}`, identity, { headers: { 'if-match': etag }, body: JSON.stringify(configuration) }),
    validateContestVersion: (versionId, key, identity) => call('POST', `/contest-versions/${encodeURIComponent(versionId)}/validate`, identity, { headers: { 'idempotency-key': key }, body: '{}' }),
    submitContestVersion: (versionId, input, etag, key, identity) => call('POST', `/contest-versions/${encodeURIComponent(versionId)}/submit`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
    listHistoric: (search = '', identity) => call('GET', `/historic-contests${search}`, identity),
    archiveContest: (contestId, etag, key, identity) => call('DELETE', `/contests/${encodeURIComponent(contestId)}`, identity, { headers: { 'if-match': etag, 'idempotency-key': key } }),
    reactivateContest: (contestId, input, etag, key, identity) => call('POST', `/contests/${encodeURIComponent(contestId)}/reactivations`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
    listApprovals: (status, identity) => call('GET', `/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`, identity),
    decideApproval: (approvalId, input, etag, key, identity) => call('POST', `/approvals/${encodeURIComponent(approvalId)}/decisions`, identity, { headers: { 'if-match': etag, 'idempotency-key': key }, body: JSON.stringify(input) }),
    startSimulation: (versionId, input, key, identity) => call('POST', `/contest-versions/${encodeURIComponent(versionId)}/simulations`, identity, { headers: { 'idempotency-key': key }, body: JSON.stringify(input) }),
    getSimulation: (simulationId, identity) => call('GET', `/simulations/${encodeURIComponent(simulationId)}`, identity),
    listAudit: (identity) => call('GET', '/audit-events', identity),
    listRules: (identity) => call('GET', '/rules', identity),
    createRule: (input, idempotencyKey, identity) => call('POST', '/rules', identity, { headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
    getRuleVersion: (ruleVersionId, identity) => call('GET', `/rule-versions/${encodeURIComponent(ruleVersionId)}`, identity),
    patchRuleVersion: (ruleVersionId, input, etag, idempotencyKey, identity) => call('PATCH', `/rule-versions/${encodeURIComponent(ruleVersionId)}`, identity, { headers: { 'if-match': etag, 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
    validateRuleVersion: (ruleVersionId, input, idempotencyKey, identity) => call('POST', `/rule-versions/${encodeURIComponent(ruleVersionId)}/validate`, identity, { headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }),
    getContestImport: (importId, identity) => call('GET', `/contest-imports/${encodeURIComponent(importId)}`, identity),
};
/**
 * Binary proxy call for brochure/import endpoints — forwards a raw
 * multipart/form-data (or empty GET) request into the same `/contests/v1`
 * routes and returns the raw injected response so the BFF route can relay
 * status/headers/bytes unchanged (mirrors the former `brochureCall` HTTP proxy).
 */
export async function injectBinary(method, path, identity = defaultIdentity, init) {
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
