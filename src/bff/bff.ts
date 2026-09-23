import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Scope, TeamView } from '../../vendor/spec/performance-vm.js';
import { DEFAULT_PERSONA, PERSONA_HEADER, PERSONAS, personaById, isLeader, type Persona } from './persona.js';
import type { LensInput } from './compose/shared.js';
import type { DataSource } from '../data/source.js';

/**
 * Resolve the calling persona from the `x-persona` request header (the SPA now
 * runs cross-origin, so the pre-migration `pa_persona` cookie can no longer
 * travel implicitly). A missing header falls back to DEFAULT_PERSONA exactly
 * as the cookie did — same (unverified) trust level as before, just a
 * different transport. A header present but not one of the known PersonaIds
 * (e.g. a typo like `LEADER_P4`) is rejected rather than silently defaulted,
 * so a misconfigured client fails loudly instead of quietly running as P2.
 */
export function getPersona(request: FastifyRequest, source?: DataSource): Persona {
  if (source?.ownIdentityOnly) {
    const id = request.headers['x-agent-id'];
    const agent = typeof id === 'string' ? source.findAgent?.(id) : undefined;
    if (!agent || (request.headers['x-tenant'] && request.headers['x-tenant'] !== 'MY')) {
      throw Object.assign(new Error('Unknown development identity'), { statusCode: 401, code: 'INS-4010' });
    }
    return { id: agent.level === 'P2' ? 'LEADER_P2' : agent.level === 'P3' ? 'LEADER_P3' : 'AGENT_P4',
      agentId: agent.agentId, level: agent.level, label: 'Development mock identity' };
  }
  const header = request.headers[PERSONA_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && !PERSONAS.some((p) => p.id === value)) {
    throw Object.assign(new Error(`Unknown x-persona: ${value}`), { statusCode: 401, code: 'BFF-4011' });
  }
  return personaById(value ?? DEFAULT_PERSONA);
}

export function problem(reply: FastifyReply, status: number, code: string, title: string, detail?: string): FastifyReply {
  return reply.status(status).send({ title, status, code, ...(detail ? { detail } : {}) });
}

const PERIODS = new Set(['MTD', 'QTD', 'YTD']);
const BLS = new Set(['ALL', 'INSURANCE', 'TAKAFUL']);
const BASES = new Set(['STANDARD', 'SCHEME']);

/** Parse + entitlement-guard the standard lens (D-14 mirrored at the BFF). Replies and returns undefined on error. */
export function parseLens(query: Record<string, unknown>, persona: Persona, reply: FastifyReply): LensInput | undefined {
  const period = String(query.period ?? 'YTD');
  const businessLine = String(query.businessLine ?? 'ALL');
  const basis = String(query.basis ?? 'STANDARD');
  const scope = String(query.scope ?? 'SELF') as Scope;
  const teamViewRaw = query.teamView !== undefined ? String(query.teamView) : undefined;
  if (!PERIODS.has(period)) { problem(reply, 400, 'BFF-4000', 'Invalid period', period); return undefined; }
  if (!BLS.has(businessLine)) { problem(reply, 400, 'BFF-4000', 'Invalid businessLine', businessLine); return undefined; }
  if (!BASES.has(basis)) { problem(reply, 400, 'BFF-4000', 'Invalid basis', basis); return undefined; }
  if (scope !== 'SELF' && scope !== 'TEAM') { problem(reply, 400, 'BFF-4000', 'Invalid scope', scope); return undefined; }
  if (scope === 'TEAM' && !isLeader(persona)) {
    problem(reply, 403, 'BFF-4032', 'scope=TEAM requires a leader persona'); return undefined;
  }
  let teamView: TeamView | undefined;
  if (scope === 'TEAM') {
    teamView = (teamViewRaw ?? 'DIRECT') as TeamView;
    if (teamView !== 'DIRECT' && teamView !== 'GROUP') { problem(reply, 400, 'BFF-4000', 'Invalid teamView', String(teamViewRaw)); return undefined; }
    if (teamView === 'GROUP' && persona.level !== 'P2') {
      problem(reply, 403, 'BFF-4031', 'teamView=GROUP requires a P2-level leader'); return undefined;
    }
  }
  return {
    period: period as LensInput['period'],
    businessLine: businessLine as LensInput['businessLine'],
    basis: basis as LensInput['basis'],
    scope,
    ...(teamView ? { teamView } : {}),
  };
}

export function mapDomainError(reply: FastifyReply, e: unknown): FastifyReply {
  const err = e as { status?: number; code?: string; title?: string; message?: string };
  const status = typeof err.status === 'number' ? err.status : 502;
  return problem(reply, status, err.code ?? 'BFF-5020', err.title ?? 'Upstream domain error', err.message);
}
