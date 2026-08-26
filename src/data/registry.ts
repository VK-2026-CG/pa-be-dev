export type AgentLevel = 'P2' | 'P3' | 'P4';
export interface AgentRecord {
  agentId: string; tenant: string; level: AgentLevel; name: string;
  /** Demo hooks for designed detail states (spec S-P4-02 §B1). */
  demoDataState?: 'EMPTY' | 'PROCESSING';
}
export const AGENTS: AgentRecord[] = [
  { agentId: 'A1001', tenant: 'MY', level: 'P4', name: 'Aisyah Rahman' },
  { agentId: 'A1002', tenant: 'MY', level: 'P4', name: 'Demo Empty', demoDataState: 'EMPTY' },
  { agentId: 'A1003', tenant: 'MY', level: 'P4', name: 'Demo Processing', demoDataState: 'PROCESSING' },
  { agentId: 'L2001', tenant: 'MY', level: 'P3', name: 'Farid Ismail' },
  { agentId: 'L3001', tenant: 'MY', level: 'P2', name: 'Mei Lin Tan' },
];
export function findAgent(agentId: string): AgentRecord | undefined {
  return AGENTS.find((a) => a.agentId === agentId);
}
