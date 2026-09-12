import type { FastifyInstance, InjectOptions } from 'fastify';
import { expect } from 'vitest';
import { personaHeaders, type PersonaKey } from './personas.js';

export const BFF = '/api/bff/v1';

/** GET a BFF endpoint as a persona, asserting 200 and returning the parsed payload. */
export async function getJson<T = any>(app: FastifyInstance, persona: PersonaKey, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url, headers: personaHeaders(persona) });
  expect(res.statusCode, `GET ${url} as ${persona}`).toBe(200);
  return res.json() as T;
}

/** GET expecting a specific status (entitlement guards, D-14). */
export async function getStatus(app: FastifyInstance, persona: PersonaKey, url: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url, headers: personaHeaders(persona) });
  return res.statusCode;
}

export async function putJson<T = any>(app: FastifyInstance, persona: PersonaKey, url: string, data: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: 'PUT', url, headers: personaHeaders(persona), payload: data as InjectOptions['payload'] });
  return { status: res.statusCode, body: res.json() as T };
}

export async function postJson(app: FastifyInstance, persona: PersonaKey, url: string, data: unknown): Promise<{ status: number }> {
  const res = await app.inject({ method: 'POST', url, headers: personaHeaders(persona), payload: data as InjectOptions['payload'] });
  return { status: res.statusCode };
}

export const metricCodes = (items: Array<{ metricCode: string }>): string[] =>
  items.map((i) => i.metricCode);
