import { readFileSync } from 'node:fs';
import type { TeamView } from '../../types.js';

/**
 * v1.7.0 (ARVIJ-157 AC-P4-02-32 / mongodb.md D-19): interim mock source for
 * the Penders case count on TPC/PTPC. No pipeline yet materializes
 * `values.pendersCaseCount` in `metric_snapshots` — this JSON file is the
 * stand-in until it does (OQ-77). Once the pipeline populates that field for real
 * (in both `values.ts`'s stub and `PerformanceSource`'s Mongo-backed read),
 * delete this file and this module, and read the field directly instead.
 * Also feeds Mongo mode (`PerformanceSource.metricDetail`) via `pendersCaseCountFor`
 * in `values.ts`, as a deliberate Penders-only exception to the no-synthetic-data rule.
 * v1.20.0 (AC-P4-02-58): keyed by `SELF` (the agent's own cases) as well as
 * the TEAM `teamView` units.
 */
export type PendersCaseCountUnit = 'SELF' | TeamView;

const MOCK_URL = new URL('./team-penders-case-count.json', import.meta.url);
const MOCK: Record<string, Record<PendersCaseCountUnit, number>> = JSON.parse(readFileSync(MOCK_URL, 'utf8'));

export function mockTeamPendersCaseCount(metricCode: string, unit: PendersCaseCountUnit): number | undefined {
  return MOCK[metricCode]?.[unit];
}
