import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ContestStep = 'BASICS' | 'AUDIENCE' | 'QUALIFICATION' | 'CALCULATION' | 'REWARDS' | 'GOVERNANCE' | 'REVIEW';

export interface ContestAdminConfig {
  configVersion: string;
  country: string;
  module: 'contest-admin';
  routes: Array<{ code: string; route: string; enabled: boolean }>;
  builder: { stepOrder: ContestStep[]; periodModes: string[]; maxRuleDepth: number; maxRuleNodes: number };
  capabilities: Record<string, boolean>;
}

const CONFIG_PATH = fileURLToPath(new URL('../../../vendor/spec/contest-admin.config.json', import.meta.url));
const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown;

export const contestAdminConfig = raw as ContestAdminConfig;
