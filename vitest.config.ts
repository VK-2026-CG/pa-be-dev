import { defineConfig } from 'vitest/config';

/** Tests must never use developer Mongo credentials or the running source profile. */
export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', MONGODB_URI: '', INSIGHTS_DATA_SOURCE: 'memory' },
  },
});