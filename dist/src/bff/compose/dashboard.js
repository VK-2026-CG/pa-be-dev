import { isLeader } from '../persona.js';
import { CONFIG, dashboardScopeConfig } from '../config.js';
import { buildMeta, mapChange, periodOptionsMeta } from './shared.js';
function card(snap, lens, showGoal, valueDisplay) {
    // Domain item without `dataState` ⇒ OK (back-compat default, C1 §7.13).
    const dataState = snap.dataState ?? 'OK';
    const ok = dataState === 'OK';
    return {
        metricCode: snap.metricCode,
        valueType: snap.valueType,
        ...(snap.variant ? { variant: snap.variant } : {}),
        // Non-OK keeps metricCode/valueType/showGoal/nav so the card still renders and
        // navigates; `value` is omitted rather than zero-filled. OK cards are emitted
        // exactly as before (dataState omitted ⇒ the contract's OK default).
        ...(ok ? {} : { dataState }),
        ...(ok && snap.collected ? { value: snap.collected } : {}),
        ...(snap.notices?.length ? { notices: snap.notices } : {}),
        showGoal,
        ...(valueDisplay ? { valueDisplay } : {}),
        ...(ok && snap.goal ? { goal: snap.goal } : {}),
        ...(ok && snap.comparison ? { delta: mapChange(snap.comparison) } : {}),
        nav: {
            route: 'insights/metric-detail',
            params: {
                metricCode: snap.metricCode,
                period: lens.period, businessLine: lens.businessLine, basis: lens.basis,
                scope: lens.scope, ...(lens.teamView ? { teamView: lens.teamView } : {}),
            },
        },
    };
}
const toQuickLink = (l) => ({ id: l.id, iconToken: l.iconToken, nav: { route: l.nav.route }, order: l.order });
export async function composeDashboard(api, persona, lens) {
    const cfg = dashboardScopeConfig(lens.scope);
    const failed = [];
    const metricsP = api.metrics(persona.agentId, persona.agentId, {
        period: lens.period, businessLine: lens.businessLine, basis: lens.basis,
        scope: lens.scope, ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
    });
    // Preferences are per-scope docs; SCHEME re-composes from catalog defaults (OQ-20 — no segment prefs yet).
    const prefsP = lens.basis === 'STANDARD'
        ? api.preferences(persona.agentId, persona.agentId, lens.scope).catch(() => null)
        : Promise.resolve(null);
    const milestonesP = api.milestones(persona.agentId, persona.agentId).catch(() => { failed.push('milestones'); return null; });
    const recoCfg = cfg.features?.recommendations;
    const recoP = recoCfg?.enabled
        ? api.recommendations(persona.agentId, persona.agentId, lens.scope).catch(() => { failed.push('recommendations'); return null; })
        : Promise.resolve(null);
    const [metrics, prefs, milestones, reco] = await Promise.all([metricsP, prefsP, milestonesP, recoP]);
    const items = metrics.items;
    const byCode = new Map(items.map((s) => [s.metricCode, s]));
    const asOfDate = metrics.context.asOfDate;
    // Priority row: preference order when saved, else the service's effective-catalog order.
    const serviceOrder = items.map((s) => s.metricCode);
    const catalogPriorityOrPref = prefs?.priorityMetricCodes?.length
        ? prefs.priorityMetricCodes
        : serviceOrder;
    const overrides = cfg.metricTracking.priorityCards.cardOverrides ?? {};
    const maxPriority = cfg.metricTracking.priorityCards.maxCount ?? 12;
    const priorityMetrics = catalogPriorityOrPref
        .map((c) => byCode.get(c))
        .filter((s) => Boolean(s))
        .slice(0, maxPriority)
        .map((s) => card(s, lens, overrides[s.metricCode]?.showGoal ?? true, overrides[s.metricCode]?.valueDisplay));
    const prioritySet = new Set(priorityMetrics.map((c) => c.metricCode));
    // Focus row: selected focus codes (prefs, else service defaults) that came back and aren't priority. Never goals.
    const focusCodes = prefs?.focusMetricCodes ?? [];
    const focusVisible = cfg.metricTracking.focusCards?.visible !== false && Boolean(cfg.metricTracking.focusCards);
    const focusAddEnabled = Boolean(cfg.metricTracking.focusCards?.addEnabled);
    const maxFocus = cfg.metricTracking.focusCards?.maxCount ?? 6;
    const focusItems = focusVisible
        ? focusCodes
            .map((c) => byCode.get(c))
            .filter((s) => Boolean(s) && !prioritySet.has(s.metricCode))
            .slice(0, maxFocus)
            .map((s) => card(s, lens, false))
        : [];
    const recommendations = {
        visible: Boolean(recoCfg?.enabled),
        count: reco?.items?.length ?? 0,
        nav: { route: recoCfg?.nav?.route ?? 'insights/recommendations' },
        ...(recoCfg?.aiPanel && reco?.panel
            ? {
                panel: {
                    recommendationId: reco.panel.recommendationId ?? 'reco-unknown',
                    flags: reco.panel.flags ?? [],
                    ...(reco.panel.highlight ? { highlight: reco.panel.highlight } : {}),
                    insights: (reco.panel.insights ?? []).map((i) => ({
                        code: i.code, titleCode: i.titleCode,
                        ...(i.metricCode ? { metricCode: i.metricCode } : {}),
                        ...(i.trend ? { trend: i.trend } : {}),
                        ...(i.narrative ? { narrative: i.narrative } : {}),
                        ...(i.cta?.route ? { nav: { route: i.cta.route, ...(i.metricCode ? { params: { metricCode: i.metricCode, scope: lens.scope } } : {}) } } : {}),
                    })),
                    ...(reco.panel.cta?.route
                        ? { cta: { labelCode: 'VIEW_TEAM_DRILLDOWN', nav: { route: reco.panel.cta.route } } }
                        : {}),
                    generatedAt: reco.panel.generatedAt,
                    ...(reco.panel.feedback?.rating ? { feedback: reco.panel.feedback.rating } : {}),
                },
            }
            : {}),
    };
    const milestoneItems = (milestones?.items ?? []).map((m) => ({
        programCode: m.programCode,
        variant: m.variant,
        cycleYear: m.cycleYear,
        currentTierCode: m.currentTier.code,
        ...(m.nextTier ? { nextTierCode: m.nextTier.code } : {}),
        progressPct: m.progressPct,
        measures: m.measures,
        nav: { route: 'insights/milestones' },
    }));
    const leader = isLeader(persona);
    const scopes = ['SELF', 'TEAM'];
    return {
        meta: buildMeta('S-P4-01', asOfDate, failed.length > 0, failed),
        filters: {
            period: lens.period,
            periodOptions: cfg.metricTracking.periodOptions,
            businessLine: lens.businessLine,
            businessLineOptions: cfg.metricTracking.businessLineTabs,
            basis: lens.basis,
            basisToggleVisible: Boolean(cfg.features?.basisToggle?.visible), // config ∧ segment entitlement (stub: true — OQ-20)
            periodOptionsMeta: periodOptionsMeta(metrics.context.period?.endDate ?? asOfDate, cfg.metricTracking.periodOptions),
            scope: lens.scope,
            ...(lens.scope === 'TEAM' ? { teamView: lens.teamView ?? 'DIRECT' } : {}),
            teamViewToggleVisible: lens.scope === 'TEAM' && Boolean(cfg.features?.teamViewToggle?.visible) && persona.level === 'P2',
        },
        ...(leader && CONFIG.screens.dashboard.scopeSwitcherEnabled
            ? {
                scopeSwitcher: {
                    current: lens.scope,
                    options: scopes.map((scope) => ({ scope })),
                    ...(persona.level === 'P2' && CONFIG.screens.dashboard.scopes.TEAM?.features?.teamViewToggle?.visible
                        ? { teamViewOptions: ['DIRECT', 'GROUP'] }
                        : {}),
                },
            }
            : {}),
        quickLinks: [...cfg.quickLinks].filter((l) => l.visible).sort((a, b) => a.order - b.order).map(toQuickLink),
        recommendations,
        priorityMetrics,
        focusMetrics: { visible: focusVisible, addEnabled: focusAddEnabled, items: focusItems },
        milestones: {
            visible: cfg.milestones.visible,
            addEnabled: Boolean(cfg.milestones.addEnabled),
            setGoalEnabled: Boolean(cfg.milestones.setGoalEnabled),
            items: cfg.milestones.visible ? milestoneItems : [],
        },
        moreActions: [...(cfg.moreActions ?? [])].sort((a, b) => a.order - b.order)
            .map((a) => ({ id: a.id, iconToken: a.iconToken, nav: { route: a.nav.route }, order: a.order })),
        footerLinks: [...(cfg.footerLinks ?? [])].filter((l) => l.visible).sort((a, b) => a.order - b.order).map(toQuickLink),
    };
}
