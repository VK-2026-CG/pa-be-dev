import { readFileSync } from 'node:fs';
import { performanceDatabase } from '../config/performance.js';
export { PERFORMANCE_DB, PERFORMANCE_COLLECTIONS } from '../config/performance.js';
/** Explicit mock authorization, never inferred from imported source records. */
export function performanceProfile(env = process.env) {
    if (!['development', 'test'].includes(env.NODE_ENV ?? ''))
        throw new Error('Performance source mode requires development/test');
    performanceDatabase(env);
    if ((env.COUNTRY_CODE ?? 'MY') !== 'MY')
        throw new Error('Performance source profile requires the MY deployment');
    let entries;
    try {
        entries = JSON.parse(env.INSIGHTS_MOCK_AGENTS_FILE ? readFileSync(env.INSIGHTS_MOCK_AGENTS_FILE, 'utf8') : env.INSIGHTS_MOCK_AGENTS ?? '{}');
    }
    catch {
        throw new Error('Invalid development identity allowlist');
    }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
        throw new Error('Invalid development identity allowlist');
    const agents = new Map();
    for (const [id, level] of Object.entries(entries)) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !['P2', 'P3', 'P4'].includes(String(level)))
            throw new Error('Invalid development identity allowlist entry');
        agents.set(id, { agentId: id, tenant: 'MY', level: level, name: 'Development mock identity' });
    }
    if (!agents.size)
        throw new Error('Performance source mode requires an explicit development identity allowlist');
    return agents;
}
