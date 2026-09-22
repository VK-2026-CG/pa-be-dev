import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist/vendor/spec', { recursive: true });
cpSync('vendor/spec', 'dist/vendor/spec', { recursive: true });
// team-penders.ts reads this JSON at runtime via fs, not `import` — tsc doesn't copy it, so mirror it into dist ourselves.
mkdirSync('dist/src/data/mocks', { recursive: true });
cpSync('src/data/mocks/team-penders-case-count.json', 'dist/src/data/mocks/team-penders-case-count.json');