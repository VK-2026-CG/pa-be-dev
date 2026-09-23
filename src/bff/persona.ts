/** Persona catalogue for the demo/stub identity model (no real auth exists yet). */
export type PersonaId =
  | "AGENT_P4"
  | "AGENT_EMPTY"
  | "AGENT_PROCESSING"
  | "LEADER_P3"
  | "LEADER_P2";
export interface Persona {
  id: PersonaId;
  agentId: string;
  level: "P2" | "P3" | "P4";
  label: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "LEADER_P2",
    agentId: "L3001",
    level: "P2",
    label: "P2 Leader (Mei Lin)",
  },
  {
    id: "LEADER_P3",
    agentId: "L2001",
    level: "P3",
    label: "P3 Leader (Farid)",
  },
  { id: "AGENT_P4", agentId: "A1001", level: "P4", label: "P4 Agent (Aisyah)" },
  {
    id: "AGENT_EMPTY",
    agentId: "A1002",
    level: "P4",
    label: "Demo: EMPTY detail",
  },
  {
    id: "AGENT_PROCESSING",
    agentId: "A1003",
    level: "P4",
    label: "Demo: PROCESSING detail",
  },
];
export const DEFAULT_PERSONA: PersonaId = "LEADER_P2";

/** Carried over from the pre-migration `pa_persona` cookie — now the `x-persona` request header (unverified, same trust level as before). */
export const PERSONA_HEADER = "x-persona";

export function personaById(id: string | undefined): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0]!;
}
export function isLeader(p: Persona): boolean {
  return p.level !== "P4";
}
