import { performanceDatabases } from '../config/performance.js';

export { PERFORMANCE_DB, PERFORMANCE_DATABASES, PERFORMANCE_COLLECTIONS, type PerformanceCollection, type PerformanceDatabaseKey } from '../config/performance.js';

/** Validate the guarded direct-source development profile; agent identities resolve from Mongo hierarchy. */
export function performanceProfile(env: NodeJS.ProcessEnv = process.env): void {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '')) throw new Error('Performance source mode requires development/test');
  performanceDatabases(env);
  if ((env.COUNTRY_CODE ?? 'MY') !== 'MY') throw new Error('Performance source profile requires the MY deployment');
}

/** Validate the read-only `my_agent_hierarchy` source profile (always on in Performance source mode). */
export function hierarchyProfile(env: NodeJS.ProcessEnv = process.env): void {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '')) throw new Error('Hierarchy source requires development/test');
  performanceDatabases(env);
  if ((env.COUNTRY_CODE ?? 'MY') !== 'MY') throw new Error('Hierarchy source requires the MY deployment');
}