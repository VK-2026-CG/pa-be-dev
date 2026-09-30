import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const CONFIG_PATH = fileURLToPath(new URL('../../vendor/spec/performance.config.json', import.meta.url));
const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
export const CONFIG = rawConfig;
export function dashboardScopeConfig(scope) {
    const c = CONFIG.screens.dashboard.scopes[scope] ?? CONFIG.screens.dashboard.scopes.SELF;
    if (!c)
        throw new Error('performance.config.json missing SELF dashboard scope');
    return c;
}
