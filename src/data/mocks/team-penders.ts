import { readFileSync } from 'node:fs';
import type { TeamView } from '../../types.js';

/**
 * v1.7.0 (ARVIJ-157 AC-P4-02-32 / mongodb.md D-19): interim mock source for
 * the TEAM-scope Penders case count on TPC/PTPC. No pipeline yet materializes
 * `values.pendersCaseCount` in `metric_snapshots` — this JSON file is the
 * stand-in until it does. Once the pipeline populates that field for real
 * (in both `values.ts`'s stub and `PerformanceSource`'s Mongo-backed read),
 * delete this file and this module, and read the field directly instead.
 */
const MOCK_URL = new URL('./team-penders-case-count.json', import.meta.url);
const MOCK: Record<string, Record<TeamView, number>> = JSON.parse(readFileSync(MOCK_URL, 'utf8'));

export function mockTeamPendersCaseCount(metricCode: string, teamView: TeamView): number | undefined {
  return MOCK[metricCode]?.[teamView];
}
