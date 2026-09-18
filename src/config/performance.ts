/** Fixed deployment source names; never selected by an HTTP request. */
export const PERFORMANCE_DB = 'pa_performance_PAMB-dev';
export const PERFORMANCE_COLLECTIONS = ['my_production', 'my_mapa', 'my_persistency'] as const;
export type PerformanceCollection = typeof PERFORMANCE_COLLECTIONS[number];
export const PERFORMANCE_READ_TIMEOUT_MS = 8000;

export function performanceDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.MONGODB_PERFORMANCE_DB ?? PERFORMANCE_DB;
  if (name !== PERFORMANCE_DB) throw new Error('Performance requires the fixed deployment database');
  return name;
}

export function performanceConnection(env: NodeJS.ProcessEnv = process.env): { database: string; uri: string } {
  const database = performanceDatabase(env);
  // An explicitly configured dedicated URI must not silently fall back.
  const uri = env.MONGODB_PERFORMANCE_URI !== undefined ? env.MONGODB_PERFORMANCE_URI : env.MONGODB_URI;
  if (!uri?.trim()) throw new Error('Performance database connection required');
  return { database, uri };
}