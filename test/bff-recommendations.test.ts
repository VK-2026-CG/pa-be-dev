import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSource } from '../src/data/source.js';
import { BFF, getJson, postJson } from './support/bff-api.js';

process.env.MONGODB_URI = ''; // tests always run the in-memory engine
const app = buildApp(await createSource());

describe('BFF recommendations feedback (S-P23-01)', () => {
  it('feedback POST → 204 and round-trips into the panel (AC-P23-01-04)', async () => {
    const before = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=SELF`);
    const recommendationId = before.recommendations.panel.recommendationId;
    expect(recommendationId).toBeTruthy();

    const { status } = await postJson(
      app, 'LEADER_P2', `${BFF}/performance/recommendations/${recommendationId}/feedback`, { rating: 'UP' },
    );
    expect(status).toBe(204);

    const after = await getJson(app, 'LEADER_P2', `${BFF}/performance/dashboard?scope=SELF`);
    expect(after.recommendations.panel.feedback).toBe('UP');
  });
});
