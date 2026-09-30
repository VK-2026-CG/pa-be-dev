/**
 * `npm run dev:mock` — test-only, credential-free fixture profile. Runs the watch server
 * on the offline stub engine (MemorySource) so every persona × scope × period
 * renders data without Mongo or any local `.env`. Values are set explicitly (not
 * deleted) because `src/db/mongo.ts` only fills env vars that are still undefined.
 */
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  INSIGHTS_DATA_SOURCE: 'memory',
  INSIGHTS_DEV_MOCK_FALLBACK: 'false',
  MONGODB_URI: '',
  MONGODB_PERFORMANCE_URI: '',
  CONTEST_BROCHURE_STORAGE: 'memory',
  CONTEST_AI_PROVIDER: 'deterministic',
};
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/server.ts'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
