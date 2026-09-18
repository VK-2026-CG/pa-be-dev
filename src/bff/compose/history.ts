import type {
  DeltaVM, HistoryTabVM, HistoryWindow, MetricHistoryVM, MetricScalar,
} from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import type { Persona } from '../persona.js';
import { CONFIG } from '../config.js';
import { buildMeta, effectiveDefs, type DomainDef, type LensInput } from './shared.js';

const WINDOW_YEARS_BACK: Record<HistoryWindow, number> = {
  CURRENT_YEAR: 0, VS_LAST_YEAR: 1, VS_LAST_2_YEARS: 2,
};
const VISIBLE_TABS = 4;

function round1(n: number): number { return Math.round(n * 10) / 10; }

function scalarNumber(v: MetricScalar): number {
  return v.kind === 'MONEY' ? Number(v.amount) : v.value;
}

/**
 * Build the MoM Delta column for the anchor year (D-11): Jan and months whose
 * own or previous value is null → null ("N/A"); unit follows the metric —
 * pp for PERCENT, abs for ABS-display metrics, pct otherwise (AC-P4-03-09/10/13).
 */
export function buildMomDeltas(points: Array<MetricScalar | null>, def: Pick<DomainDef, 'favourability' | 'changeDisplay' | 'valueType'>): Array<DeltaVM | null> {
  return points.map((value, i) => {
    if (i === 0 || value === null) return null;
    const prev = points[i - 1];
    if (prev === null || prev === undefined) return null;
    const cur = scalarNumber(value);
    const pri = scalarNumber(prev);
    const diff = cur - pri;
    const direction: DeltaVM['direction'] = diff === 0 ? 'FLAT' : diff > 0 ? 'UP' : 'DOWN';
    const good = def.favourability === 'HIGHER_IS_BETTER' ? diff > 0 : diff < 0;
    const sentiment: DeltaVM['sentiment'] = diff === 0 ? 'NEUTRAL' : good ? 'POSITIVE' : 'NEGATIVE';
    const base: Omit<DeltaVM, 'display'> = { comparisonBasis: 'LAST_MONTH', direction, sentiment };
    if (def.valueType === 'PERCENT') return { ...base, display: 'PP', pp: round1(diff) };
    if (def.changeDisplay === 'ABS') {
      const abs: MetricScalar = value.kind === 'MONEY'
        ? { kind: 'MONEY', amount: `${diff < 0 ? '-' : ''}${Math.abs(diff).toFixed(2)}`, currency: value.currency }
        : value.kind === 'DECIMAL'
          ? { kind: 'DECIMAL', value: round1(diff), precision: value.precision ?? 1 }
          : { kind: 'COUNT', value: diff };
      return { ...base, display: 'ABS', abs };
    }
    const pct = pri === 0 ? 0 : round1(((cur - pri) / pri) * 100);
    return { ...base, display: 'PCT', pct };
  });
}

export function splitTabs(all: string[], selected: string): { tabs: HistoryTabVM[]; moreTabs: HistoryTabVM[] } {
  let visible = all.slice(0, VISIBLE_TABS);
  let overflow = all.slice(VISIBLE_TABS);
  if (overflow.includes(selected)) {
    // Swap the selected overflow metric into view (AC-P4-03-12).
    overflow = overflow.filter((c) => c !== selected);
    const displaced = visible[visible.length - 1];
    visible = [...visible.slice(0, -1), selected];
    if (displaced) overflow = [displaced, ...overflow];
  }
  const mk = (metricCode: string): HistoryTabVM => ({ metricCode, selected: metricCode === selected });
  return { tabs: visible.map(mk), moreTabs: overflow.map(mk) };
}

export async function composeHistory(
  api: DomainApi, persona: Persona, metricCode: string, lens: LensInput, window: HistoryWindow,
): Promise<MetricHistoryVM> {
  const cfg = CONFIG.screens.history;
  const yearsBack = WINDOW_YEARS_BACK[window];
  const [series, defsPayload] = await Promise.all([
    api.series(persona.agentId, persona.agentId, metricCode, {
      businessLine: lens.businessLine, basis: lens.basis,
      scope: lens.scope, ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
      yearsBack,
    }),
    api.definitions(persona.agentId),
  ]);

  const defs: DomainDef[] = defsPayload.items;
  const def = defs.find((d) => d.metricCode === metricCode);
  if (!def) throw new Error(`Unknown metric ${metricCode} in catalog`);

  const years: number[] = series.series.map((y: any) => y.year);
  const rows = Array.from({ length: 12 }, (_, mi) => ({
    month: mi + 1,
    values: series.series.map((y: any) => y.points[mi]?.value ?? null) as Array<MetricScalar | null>,
  }));

  const anchorPoints = (series.series[0]?.points ?? []).map((p: any) => p.value ?? null) as Array<MetricScalar | null>;
  const momDeltas = window === 'CURRENT_YEAR' ? buildMomDeltas(anchorPoints, def) : undefined;

  const allTabs = effectiveDefs(defs, lens.scope, lens.basis)
    .filter((d) => (cfg.tabs[lens.scope] ?? []).includes(d.metricCode))
    .map((d) => d.metricCode);
  const orderedTabs = (cfg.tabs[lens.scope] ?? []).filter((c) => allTabs.includes(c));
  const { tabs, moreTabs } = splitTabs(orderedTabs, metricCode);

  const idx = cfg.windows.indexOf(window);
  return {
    meta: buildMeta('S-P4-03', series.context?.asOfDate ?? '2026-07-27'),
    tabs,
    moreTabs,
    metricCode,
    valueType: def.valueType,
    context: {
      businessLine: lens.businessLine, basis: lens.basis, scope: lens.scope,
      ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
    },
    comparison: {
      window,
      windowOptions: cfg.windows,
      anchorYear: series.anchorYear,
      yearsBack,
      canGoOlder: idx < cfg.windows.length - 1,
      canGoNewer: idx > 0,
    },
    years,
    rows,
    ...(momDeltas ? { momDeltas } : {}),
  };
}
