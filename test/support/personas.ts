/**
 * Persona stub identity — carried over from pa-fe-dev's `tests/support/personas.ts`.
 * Travels as the `x-persona` request header now (was the `pa_persona` cookie
 * pre-migration) — same stub identities, same trust level (unverified).
 */
export const PERSONAS = {
  LEADER_P2: 'LEADER_P2',
  LEADER_P3: 'LEADER_P3',
  AGENT_P4: 'AGENT_P4',
  AGENT_EMPTY: 'AGENT_EMPTY',
  AGENT_PROCESSING: 'AGENT_PROCESSING',
} as const;

export type PersonaKey = keyof typeof PERSONAS;

export function personaHeaders(persona: PersonaKey): Record<string, string> {
  return { 'x-persona': PERSONAS[persona] };
}
