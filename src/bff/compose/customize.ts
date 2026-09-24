import type { CustomizeItemVM, CustomizeMetricsVM, Scope } from '../../../vendor/spec/performance-vm.js';
import type { DomainApi } from '../domain-client.js';
import type { Persona } from '../persona.js';
import { CONFIG } from '../config.js';
import { buildMeta, effectiveDefs, type DomainDef } from './shared.js';

/** Customize edits the STANDARD-segment doc per scope (segment prefs — OQ-20). */
export async function composeCustomize(
  api: DomainApi, persona: Persona, scope: Scope,
): Promise<CustomizeMetricsVM> {
  const [defsPayload, prefs] = await Promise.all([
    api.definitions(persona.agentId),
    api.preferences(persona.agentId, persona.agentId, scope),
  ]);
  const defs: DomainDef[] = defsPayload.items;
  const eff = effectiveDefs(defs, scope, 'STANDARD');
  const byCode = new Map(eff.map((d) => [d.metricCode, d]));
  const constraints = CONFIG.screens.customize.scopes[scope]
    ?? CONFIG.screens.customize.scopes.SELF
    ?? { priority: { min: 4, max: 4, editable: false }, focus: { min: 0, max: 6 } };

  const priorityOrder: string[] = prefs.priorityMetricCodes;
  const priority: CustomizeItemVM[] = priorityOrder
    .map((c, i): CustomizeItemVM | null => {
      const d = byCode.get(c);
      if (!d) return null;
      return {
        metricCode: c,
        ...(d.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' as const } : {}),
        selected: true,
        locked: !constraints.priority.editable || !d.customizable,
        reorderable: true,
        order: i + 1,
      };
    })
    .filter((x): x is CustomizeItemVM => x !== null);

  const focusSelected: string[] = prefs.focusMetricCodes;
  const focusDefs = eff.filter((d) => d.effCategory === 'FOCUS');
  const selectedFirst = [
    ...focusSelected.map((c) => focusDefs.find((d) => d.metricCode === c)).filter((d): d is typeof focusDefs[number] => Boolean(d)),
    ...focusDefs.filter((d) => !focusSelected.includes(d.metricCode)),
  ];
  const focus: CustomizeItemVM[] = selectedFirst.map((d, i) => ({
    metricCode: d.metricCode,
    selected: focusSelected.includes(d.metricCode),
    locked: false,
    reorderable: true,
    order: i + 1,
  }));

  return {
    meta: buildMeta('S-P4-04', '2026-07-27'),
    scope,
    priority,
    focus,
    constraints,
  };
}
