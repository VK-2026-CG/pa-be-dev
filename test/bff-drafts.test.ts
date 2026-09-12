import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

/** Draft packs ride proposed VMs behind stubs marked draft: true (OQ-17/18). */
describe('BFF draft packs (S-P4-05 / S-P4-06)', () => {
  it('benefits payload is flagged draft', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/benefits`);
    expect(d.draft).toBe(true);
    expect(d.bonus).toHaveLength(3);
  });

  it('comp-ben payload incl. staleness banner data (AC-P4-06-04)', async () => {
    const d = await getJson(app, 'AGENT_P4', `${BFF}/compensation?stale=1`);
    expect(d.draft).toBe(true);
    expect(d.rows[2].amount.amount).toBe('33495.70');
    expect(d.staleness.asOnDate).toBe('2026-03-09');
  });
});
