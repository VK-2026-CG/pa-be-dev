/** Fixed deployment source names; never selected by an HTTP request. */
export const PERFORMANCE_DATABASES = { PAMB: 'pa_performance_PAMB-dev', PBTB: 'pa_performance_PBTB-dev' };
/** Convenience alias: most fixtures/tests are INSURANCE(PAMB)-only. */
export const PERFORMANCE_DB = PERFORMANCE_DATABASES.PAMB;
/** Metric import/provisioning allowlist; hierarchy is read-only and never imported. */
export const PERFORMANCE_COLLECTIONS = ['my_production', 'my_mapa', 'my_persistency'];
export const PERFORMANCE_HIERARCHY_COLLECTION = 'my_agent_hierarchy';
export const PERFORMANCE_READ_TIMEOUT_MS = 8000;
const DATABASE_ENV_VAR = { PAMB: 'MONGODB_PAMB_DB', PBTB: 'MONGODB_PBTB_DB' };
export function performanceDatabaseName(key, env = process.env) {
    const name = env[DATABASE_ENV_VAR[key]] ?? PERFORMANCE_DATABASES[key];
    if (name !== PERFORMANCE_DATABASES[key])
        throw new Error('Performance requires the fixed deployment database');
    return name;
}
export function performanceDatabases(env = process.env) {
    return { PAMB: performanceDatabaseName('PAMB', env), PBTB: performanceDatabaseName('PBTB', env) };
}
export function performanceConnection(env = process.env) {
    const databases = performanceDatabases(env);
    // An explicitly configured dedicated URI must not silently fall back.
    const uri = env.MONGODB_PERFORMANCE_URI !== undefined ? env.MONGODB_PERFORMANCE_URI : env.MONGODB_URI;
    if (!uri?.trim())
        throw new Error('Performance database connection required');
    return { databases, uri };
}
