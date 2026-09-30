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
const TEAM_DRILLDOWN_CONFIG_PATH = fileURLToPath(new URL('../../vendor/spec/team-drilldown.config.json', import.meta.url));
export const TEAM_DRILLDOWN_CONFIG = JSON.parse(readFileSync(TEAM_DRILLDOWN_CONFIG_PATH, 'utf8'));
/** Badge codes accepted by the `badges` filter: the C4 groups only (VIOLET is display-only, D-P4-07-01). */
export const FILTERABLE_BADGES = new Set(TEAM_DRILLDOWN_CONFIG.memberList.badgeGroups.flatMap((g) => g.badges));
