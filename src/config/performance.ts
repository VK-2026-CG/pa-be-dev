/** Fixed deployment source names; never selected by an HTTP request. */
export const PERFORMANCE_DATABASES = { PAMB: 'pa_performance_PAMB-dev', PBTB: 'pa_performance_PBTB-dev' } as const;
export type PerformanceDatabaseKey = keyof typeof PERFORMANCE_DATABASES;
/** Convenience alias: most fixtures/tests are INSURANCE(PAMB)-only. */
export const PERFORMANCE_DB = PERFORMANCE_DATABASES.PAMB;
export const PERFORMANCE_COLLECTIONS = ['my_production', 'my_mapa', 'my_persistency'] as const;
export type PerformanceCollection = typeof PERFORMANCE_COLLECTIONS[number];
export const PERFORMANCE_READ_TIMEOUT_MS = 8000;

const DATABASE_ENV_VAR: Record<PerformanceDatabaseKey, string> = { PAMB: 'MONGODB_PAMB_DB', PBTB: 'MONGODB_PBTB_DB' };

export function performanceDatabaseName(key: PerformanceDatabaseKey, env: NodeJS.ProcessEnv = process.env): string {
  const name = env[DATABASE_ENV_VAR[key]] ?? PERFORMANCE_DATABASES[key];
  if (name !== PERFORMANCE_DATABASES[key]) throw new Error('Performance requires the fixed deployment database');
  return name;
}

export function performanceDatabases(env: NodeJS.ProcessEnv = process.env): Record<PerformanceDatabaseKey, string> {
  return { PAMB: performanceDatabaseName('PAMB', env), PBTB: performanceDatabaseName('PBTB', env) };
}

export function performanceConnection(env: NodeJS.ProcessEnv = process.env): { databases: Record<PerformanceDatabaseKey, string>; uri: string } {
  const databases = performanceDatabases(env);
  // An explicitly configured dedicated URI must not silently fall back.
  const uri = env.MONGODB_PERFORMANCE_URI !== undefined ? env.MONGODB_PERFORMANCE_URI : env.MONGODB_URI;
  if (!uri?.trim()) throw new Error('Performance database connection required');
  return { databases, uri };
}
