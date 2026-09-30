export const AGENTS = [
    { agentId: 'A1001', tenant: 'MY', level: 'P4', name: 'Aisyah Rahman' },
    { agentId: 'A1002', tenant: 'MY', level: 'P4', name: 'Demo Empty', demoDataState: 'EMPTY' },
    { agentId: 'A1003', tenant: 'MY', level: 'P4', name: 'Demo Processing', demoDataState: 'PROCESSING' },
    { agentId: 'L2001', tenant: 'MY', level: 'P3', name: 'Farid Ismail' },
    { agentId: 'L3001', tenant: 'MY', level: 'P2', name: 'Mei Lin Tan' },
    { agentId: '1136911', tenant: 'MY', level: 'P3', name: 'Mei Lin Tan' }
];
export function findAgent(agentId) {
    return AGENTS.find((a) => a.agentId === agentId);
}
