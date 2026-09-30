import { CONFIG } from '../config.js';
import { buildMeta, effectiveDefs } from './shared.js';
/** Customize edits the STANDARD-segment doc per scope (segment prefs — OQ-20). */
export async function composeCustomize(api, persona, scope) {
    const [defsPayload, prefs] = await Promise.all([
        api.definitions(persona.agentId),
        api.preferences(persona.agentId, persona.agentId, scope),
    ]);
    const defs = defsPayload.items;
    const eff = effectiveDefs(defs, scope, 'STANDARD');
    const byCode = new Map(eff.map((d) => [d.metricCode, d]));
    const constraints = CONFIG.screens.customize.scopes[scope]
        ?? CONFIG.screens.customize.scopes.SELF
        ?? { priority: { min: 4, max: 4, editable: false }, focus: { min: 0, max: 6 } };
    const priorityOrder = prefs.priorityMetricCodes;
    const priority = priorityOrder
        .map((c, i) => {
        const d = byCode.get(c);
        if (!d)
            return null;
        return {
            metricCode: c,
            ...(d.capabilities.repricing ? { variant: 'WITHOUT_REPRICING' } : {}),
            selected: true,
            locked: !constraints.priority.editable || !d.customizable,
            reorderable: true,
            order: i + 1,
        };
    })
        .filter((x) => x !== null);
    const focusSelected = prefs.focusMetricCodes;
    const focusDefs = eff.filter((d) => d.effCategory === 'FOCUS');
    const selectedFirst = [
        ...focusSelected.map((c) => focusDefs.find((d) => d.metricCode === c)).filter((d) => Boolean(d)),
        ...focusDefs.filter((d) => !focusSelected.includes(d.metricCode)),
    ];
    const focus = selectedFirst.map((d, i) => ({
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
