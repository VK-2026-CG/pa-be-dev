import type { AgentRecord } from './registry.js';
import { readFileSync } from 'node:fs';
import { performanceDatabases } from '../config/performance.js';

export { PERFORMANCE_DB, PERFORMANCE_DATABASES, PERFORMANCE_COLLECTIONS, type PerformanceCollection, type PerformanceDatabaseKey } from '../config/performance.js';

/** Explicit mock authorization, never inferred from imported source records. */
export function performanceProfile(env: NodeJS.ProcessEnv = process.env): Map<string, AgentRecord> {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '')) throw new Error('Performance source mode requires development/test');
  performanceDatabases(env);
  if ((env.COUNTRY_CODE ?? 'MY') !== 'MY') throw new Error('Performance source profile requires the MY deployment');
  let entries: unknown;
  try { entries = JSON.parse(env.INSIGHTS_MOCK_AGENTS_FILE ? readFileSync(env.INSIGHTS_MOCK_AGENTS_FILE, 'utf8') : env.INSIGHTS_MOCK_AGENTS ?? '{}'); }
  catch { throw new Error('Invalid development identity allowlist'); }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid development identity allowlist');
  const agents = new Map<string, AgentRecord>();
  for (const [id, level] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !['P2', 'P3', 'P4'].includes(String(level))) throw new Error('Invalid development identity allowlist entry');
    agents.set(id, { agentId: id, tenant: 'MY', level: level as AgentRecord['level'], name: 'Development mock identity' });
  }
  if (!agents.size) throw new Error('Performance source mode requires an explicit development identity allowlist');
  return agents;
}