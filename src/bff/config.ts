import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PeriodType, BusinessLine, Scope, TeamView } from '../../vendor/spec/performance-vm.js';

export interface QuickLinkCfg { id: string; iconToken: string; nav: { route: string }; order: number; visible: boolean }
export interface MoreActionCfg { id: string; iconToken: string; nav: { route: string }; order: number }
export interface CardRowCfg {
  visible?: boolean; addEnabled?: boolean; maxCount?: number; widget: string; widgetVariant?: string;
  cardOverrides?: Record<string, { showGoal?: boolean; valueDisplay?: 'FULL' | 'COMPACT' }>;
}
export interface DashboardScopeCfg {
  features?: {
    basisToggle?: { visible?: boolean };
    teamViewToggle?: { visible?: boolean; default?: TeamView };
    recommendations?: { enabled?: boolean; aiPanel?: boolean; nav?: { route: string } };
  };
  quickLinks: QuickLinkCfg[];
  metricTracking: {
    periodOptions: PeriodType[]; defaultPeriod: PeriodType;
    businessLineTabs: BusinessLine[]; defaultBusinessLine: BusinessLine;
    priorityCards: CardRowCfg; focusCards?: CardRowCfg;
  };
  milestones: { visible: boolean; addEnabled?: boolean; setGoalEnabled?: boolean; programs?: string[]; widget: string; widgetVariant?: string };
  moreActions?: MoreActionCfg[];
  footerLinks?: QuickLinkCfg[];
}
export interface PerformanceConfig {
  configVersion: string; country: string; module: string;
  screens: {
    dashboard: { screenId: string; scopeSwitcherEnabled?: boolean; scopes: Partial<Record<Scope, DashboardScopeCfg>> };
    metricDetail: {
      screenId: string; sectionOrder: string[];
      sections: Array<{ id: string; widget: string; widgetVariant?: string; order: number; visible: boolean }>;
      historyLinkEnabled?: boolean;
    };
    history: {
      screenId: string; tabs: Partial<Record<Scope, string[]>>;
      windows: Array<'CURRENT_YEAR' | 'VS_LAST_YEAR' | 'VS_LAST_2_YEARS'>;
      defaultWindow: 'CURRENT_YEAR' | 'VS_LAST_YEAR' | 'VS_LAST_2_YEARS';
      maxYearsBack?: number;
    };
    customize: {
      screenId: string;
      scopes: Partial<Record<Scope, { priority: { min: number; max: number; editable: boolean }; focus: { min: number; max: number } }>>;
    };
  };
}

const CONFIG_PATH = fileURLToPath(new URL('../../vendor/spec/performance.config.json', import.meta.url));
const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown;

export const CONFIG = rawConfig as PerformanceConfig;

export function dashboardScopeConfig(scope: Scope): DashboardScopeCfg {
  const c = CONFIG.screens.dashboard.scopes[scope] ?? CONFIG.screens.dashboard.scopes.SELF;
  if (!c) throw new Error('performance.config.json missing SELF dashboard scope');
  return c;
}
