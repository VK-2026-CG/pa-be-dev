import { readFileSync } from 'node:fs';
const MOCK_URL = new URL('./team-penders-case-count.json', import.meta.url);
const MOCK = JSON.parse(readFileSync(MOCK_URL, 'utf8'));
export function mockTeamPendersCaseCount(metricCode, unit) {
    return MOCK[metricCode]?.[unit];
}
