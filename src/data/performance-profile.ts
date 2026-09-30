import { performanceDatabases } from '../config/performance.js';

export { PERFORMANCE_DB, PERFORMANCE_DATABASES, PERFORMANCE_COLLECTIONS, type PerformanceCollection, type PerformanceDatabaseKey } from '../config/performance.js';

/** Validate the guarded direct-source development profile; agent identities resolve from Mongo hierarchy. */
export function performanceProfile(env: NodeJS.ProcessEnv = process.env): void {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '')) throw new Error('Performance source mode requires development/test');
  performanceDatabases(env);
  if ((env.COUNTRY_CODE ?? 'MY') !== 'MY') throw new Error('Performance source profile requires the MY deployment');
}

/** Validate the separately authorized read-only organization source profile. */
export function hierarchyProfile(env: NodeJS.ProcessEnv = process.env): void {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '')) throw new Error('Hierarchy source requires development/test');
  performanceDatabases(env);
  if ((env.COUNTRY_CODE ?? 'MY') !== 'MY') throw new Error('Hierarchy source requires the MY deployment');
  if (env.INSIGHTS_HIERARCHY_SOURCE !== 'true') throw new Error('Hierarchy source requires explicit opt-in');
}