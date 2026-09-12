import type {
  BarComparisonSectionVM, MetricDetailSectionVM, MetricDetailVM, PercentValue,
} from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import type { Persona } from '../persona.js';
import { CONFIG } from '../config.js';
import { buildMeta, mapChange, type DomainChange, type LensInput } from './shared.js';

interface DomainDetail {
  metricCode: string;
  valueType: MetricDetailVM['sections'][number] extends never ? never : 'MONEY' | 'COUNT' | 'PERCENT' | 'DECIMAL';
  context: {
    period: { type: LensInput['period'] };
    businessLine: LensInput['businessLine'];
    basis: LensInput['basis'];
    scope: LensInput['scope'];
    teamView?: 'DIRECT' | 'GROUP';
    asOfDate: string;
  };
  dataState: 'OK' | 'PROCESSING' | 'EMPTY';
  notices?: MetricDetailVM['notices'];
  primary?: { variant?: 'WITHOUT_REPRICING' | 'WITH_REPRICING'; collected: any; penders?: any };
  altVariants?: Array<{ variant: 'WITHOUT_REPRICING' | 'WITH_REPRICING'; collected: any }>;
  comparison?: { current: any; prior: any; priorYear: number; change: DomainChange };
  threshold?: { value: number; comparator: 'GTE' | 'LTE' };
  breakdowns?: Array<{ variant: 'WITHOUT_REPRICING' | 'WITH_REPRICING'; columns: any[]; rows: any[]; totals: any[] }>;
  barComparison?: {
    years: number[]; axis?: { unitCode?: string };
    measures: Array<{ measureCode?: string; points: Array<{ year: number; value: any; change?: DomainChange }> }>;
  };
}

function anchorYearOf(asOfDate: string): number { return Number(asOfDate.slice(0, 4)); }

/**
 * Section builders keyed by config section id. A builder returns null when
 * the metric lacks the capability/data — the section is simply not emitted
 * (AC-P4-02-01/02); unknown config ids are skipped (AC-P4-02-07).
 */
function buildSection(id: string, d: DomainDetail): MetricDetailSectionVM | null {
  const year = anchorYearOf(d.context.asOfDate);
  switch (id) {
    case 'gauge.primary': {
      if (!d.primary || d.threshold || d.barComparison) return null;
      return {
        type: 'GAUGE', id,
        ...(d.primary.variant ? { variant: d.primary.variant } : {}),
        collected: d.primary.collected,
        ...(d.primary.penders ? { penders: d.primary.penders } : {}),
      };
    }
    case 'bars.primary': {
      const bc = d.barComparison;
      if (!bc) return null;
      const vm: BarComparisonSectionVM = {
        type: 'BAR_COMPARISON', id,
        years: bc.years,
        ...(bc.axis?.unitCode ? { axisUnitCode: bc.axis.unitCode } : {}),
        measures: bc.measures.map((m) => ({
          ...(m.measureCode ? { measureCode: m.measureCode } : {}),
          points: m.points.map((p) => ({
            year: p.year, value: p.value,
            ...(p.change ? { change: mapChange(p.change) } : {}),
          })),
        })),
      };
      return vm;
    }
    case 'threshold.primary': {
      if (!d.threshold || !d.primary || d.primary.collected.kind !== 'PERCENT') return null;
      const current = d.primary.collected as PercentValue;
      const met = d.threshold.comparator === 'GTE'
        ? current.value >= d.threshold.value
        : current.value <= d.threshold.value;
      return { type: 'THRESHOLD_GAUGE', id, current, threshold: d.threshold, sentiment: met ? 'POSITIVE' : 'NEGATIVE' };
    }
    case 'comparison.primary': {
      if (!d.comparison) return null;
      return {
        type: 'COMPARISON', id,
        ...(d.primary?.variant && d.altVariants?.length ? { variant: d.primary.variant } : {}),
        currentYear: year,
        current: d.comparison.current,
        priorYear: d.comparison.priorYear,
        prior: d.comparison.prior,
        change: mapChange(d.comparison.change),
      };
    }
    case 'variant.with-repricing': {
      const alt = d.altVariants?.find((v) => v.variant === 'WITH_REPRICING');
      if (!alt) return null;
      return { type: 'VARIANT_VALUE', id, variant: alt.variant, periodLabelYear: year, value: alt.collected };
    }
    case 'penders.primary': {
      if (!d.primary?.penders || d.primary.collected.kind !== 'COUNT') return null;
      return { type: 'PENDERS', id, periodLabelYear: year, value: d.primary.penders };
    }
    case 'breakdown.without-repricing':
    case 'breakdown.with-repricing': {
      const variant = id.endsWith('with-repricing') ? 'WITH_REPRICING' : 'WITHOUT_REPRICING';
      const table = d.breakdowns?.find((b) => b.variant === variant);
      if (!table) return null;
      return { type: 'BREAKDOWN', id, variant: table.variant, columns: table.columns, rows: table.rows, totals: table.totals };
    }
    default:
      return null; // unknown section id in config — skip safely
  }
}

export async function composeMetricDetail(
  api: DomainApi, persona: Persona, metricCode: string, lens: LensInput,
): Promise<MetricDetailVM> {
  const d: DomainDetail = await api.metricDetail(persona.agentId, persona.agentId, metricCode, {
    period: lens.period, businessLine: lens.businessLine, basis: lens.basis,
    scope: lens.scope, ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
  });

  const cfg = CONFIG.screens.metricDetail;
  const sections = d.dataState === 'OK'
    ? cfg.sectionOrder
        .map((id) => buildSection(id, d))
        .filter((s): s is MetricDetailSectionVM => s !== null)
    : [];

  const historyTabs = CONFIG.screens.history.tabs[lens.scope] ?? [];
  const historyNav = cfg.historyLinkEnabled !== false && historyTabs.includes(metricCode)
    ? {
        route: 'insights/history',
        params: {
          metricCode, scope: lens.scope, businessLine: lens.businessLine, basis: lens.basis,
          ...(lens.teamView ? { teamView: lens.teamView } : {}),
        },
      }
    : undefined;

  return {
    meta: buildMeta('S-P4-02', d.context.asOfDate),
    context: {
      metricCode,
      scope: d.context.scope,
      ...(d.context.teamView ? { teamView: d.context.teamView } : {}),
      businessLine: d.context.businessLine,
      period: d.context.period.type,
      basis: d.context.basis,
      asOfDate: d.context.asOfDate,
    },
    dataState: d.dataState,
    ...(d.notices?.length ? { notices: d.notices } : {}),
    sections,
    ...(historyNav ? { historyNav } : {}),
  };
}
