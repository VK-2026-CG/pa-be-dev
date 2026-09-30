export const PERSONAS = [
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
export const DEFAULT_PERSONA = "LEADER_P2";
/** Carried over from the pre-migration `pa_persona` cookie — now the `x-persona` request header (unverified, same trust level as before). */
export const PERSONA_HEADER = "x-persona";
export function personaById(id) {
    return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
}
export function isLeader(p) {
    return p.level !== "P4";
}
