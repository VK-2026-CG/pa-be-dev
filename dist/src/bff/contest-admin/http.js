import { ContestDomainError } from './domain-client.js';
/**
 * Buffer the raw request body ourselves rather than via `@fastify/multipart`'s
 * `request.file()`/`.parts()` — these two proxy routes just relay the original
 * multipart bytes untouched into the internal `/contests/v1` route (which does
 * its own `request.file()` parsing), same as the former HTTP proxy. `@fastify/multipart`'s
 * content-type parser only sets a flag and calls `done()` without touching the
 * stream, so `request.raw` is still pristine here.
 */
export async function readRawBody(request) {
    const chunks = [];
    for await (const chunk of request.raw)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}
const mapMessage = (code) => ({
    'CON-4091': 'contest.error.duplicateCode',
    'CON-4092': 'contest.error.staleSnapshot',
    'CON-4121': 'contest.error.conflict',
    'CON-4221': 'contest.error.ruleInvalid',
    'CON-4041': 'contest.error.notFound',
}[code] ?? 'contest.error.generic');
/** Run a contest-admin composer and reply with its result, translating ContestDomainError into the BFF's messageKey shape. */
export async function contestAsyncResponse(reply, work, status = 200) {
    try {
        const body = await work();
        reply.status(status).send(body);
    }
    catch (error) {
        if (error instanceof ContestDomainError) {
            reply.status(error.status).send({
                status: error.status,
                code: error.problem.code,
                messageKey: mapMessage(error.problem.code),
                traceId: error.problem.traceId,
                errors: error.problem.errors?.map((item) => ({ ...item, messageKey: item.messageKey ?? mapMessage(item.code) })),
            });
            return;
        }
        throw error;
    }
}
/** The idempotency-key precondition every contest-admin write route enforces before calling the domain. */
export function requireIdempotencyKey(reply, key, traceId) {
    if (key && !Array.isArray(key))
        return true;
    reply.status(422).send({ status: 422, code: 'CON-4221', messageKey: 'contest.error.idempotencyRequired', traceId });
    return false;
}
