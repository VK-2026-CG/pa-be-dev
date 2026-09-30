import type { FastifyInstance } from 'fastify';
import type { DataSource } from '../data/source.js';
import { createInsightsDomain } from './domain-client.js';
import { initContestDomainClient } from './contest-admin/domain-client.js';
import { registerPerformanceRoutes } from './routes/performance.js';
import { registerContestAdminRoutes } from './routes/contest-admin.js';

/**
 * Mount the BFF composition layer (formerly pa-fe-dev's `src/app/api/bff/v1/**`)
 * as additional routes on the same Fastify app that already serves the
 * Insights (`/insights/v1`) and Contest Admin (`/contests/v1`) domain areas —
 * same URL shape (`/api/bff/v1/...`), so only the host/port changes for callers.
 */
export function registerBffRoutes(app: FastifyInstance, source: DataSource): void {
  const insightsDomain = createInsightsDomain(source);
  initContestDomainClient(app);
  registerPerformanceRoutes(app, insightsDomain);
  registerContestAdminRoutes(app);
}
