import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const CONFIG_PATH = fileURLToPath(new URL('../../../vendor/spec/contest-admin.config.json', import.meta.url));
const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
export const contestAdminConfig = raw;
