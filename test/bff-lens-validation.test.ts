import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getStatus } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

/** parseLens rejects unknown lens values with BFF-4000 before touching the domain. */
describe('BFF lens validation', () => {
  for (const [name, qs] of [
    ['period', 'period=DECADE'],
    ['businessLine', 'businessLine=WHOLESALE'],
    ['basis', 'basis=CUSTOM'],
    ['scope', 'scope=REGION'],
  ] as const) {
    it(`invalid ${name} → 400`, async () => {
      const status = await getStatus(app, 'LEADER_P2', `${BFF}/performance/dashboard?${qs}`);
      expect(status).toBe(400);
    });
  }

  it('invalid teamView → 400', async () => {
    const status = await getStatus(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=TEAM&teamView=REGION`);
    expect(status).toBe(400);
  });
});
