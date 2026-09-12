import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF history (S-P4-03)', () => {
  it('CURRENT_YEAR: 1 year, MoM column, Jan null (AC-P4-03-09)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC/history?window=CURRENT_YEAR`);
    expect(d.years).toEqual([2026]);
    expect(d.momDeltas[0]).toBeNull();
    expect(d.momDeltas[1].comparisonBasis).toBe('LAST_MONTH');
    expect(d.comparison.canGoOlder).toBe(true);
    expect(d.comparison.canGoNewer).toBe(false);
  });

  it('VS_LAST_2_YEARS: 3 year columns, no MoM (AC-P4-03-02)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/performance/metrics/TPC/history?window=VS_LAST_2_YEARS`);
    expect(d.years).toEqual([2026, 2025, 2024]);
    expect(d.momDeltas).toBeUndefined();
    expect(d.comparison.canGoOlder).toBe(false);
  });

  it('TEAM tabs: 9 with overflow behind More Metrics (AC-P4-03-12)', async () => {
    const d = await getJson(
      app, 'LEADER_P2',
      `${BFF}/performance/metrics/PRODUCTIVITY/history?window=CURRENT_YEAR&scope=TEAM`,
    );
    expect(d.tabs).toHaveLength(4);
    expect(d.moreTabs).toHaveLength(5);
    expect(d.tabs.some((t: any) => t.metricCode === 'PRODUCTIVITY' && t.selected)).toBe(true);
  });
});
