/**
 * PRUAction — Performance (P4) View Models
 * Contract C3: Next.js BFF → UI (CDK widgets)
 *
 * @version 1.6.0  (stacked bar-comparison layout — see CHANGES below)
 * @module bff/types/performance-vm
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BFF ROUTE TABLE (Next.js route handlers)
 * ─────────────────────────────────────────────────────────────────────────────
 * | Route (app router)                                  | Returns                | Composes (domain ops)                                   |
 * |-----------------------------------------------------|------------------------|---------------------------------------------------------|
 * | GET  /api/bff/v1/performance/dashboard              | PerformanceDashboardVM | listAgentMetrics + listMilestoneProgress                |
 * |        ?period&businessLine&basis&scope&teamView    |                        | + listRecommendations + screen config (C4)              |
 * | GET  /api/bff/v1/performance/metrics/:metricCode    | MetricDetailVM         | getMetricDetail + listMetricDefinitions (capabilities)  |
 * |        ?period&businessLine&basis&scope&teamView    |                        |                                                         |
 * | GET  /api/bff/v1/performance/metrics/:metricCode/history | MetricHistoryVM   | getMetricSeries + config (history windows/tabs)         |
 * |        ?businessLine&basis&scope&teamView&anchorYear&yearsBack |             |   (yearsBack=0 ⇒ Current Year + MoM deltas, D-11)       |
 * | GET  /api/bff/v1/performance/customize?scope        | CustomizeMetricsVM     | listMetricDefinitions + getMetricPreferences            |
 * | PUT  /api/bff/v1/performance/customize?scope        | CustomizeMetricsVM     | putMetricPreferences                                    |
 * | POST /api/bff/v1/performance/recommendations/:id/feedback | 204            | submitRecommendationFeedback                            |
 *
 * v1.1.0 CHANGES (all additive):
 *  - `scope` (SELF|TEAM) + `teamView` (DIRECT|GROUP) filter dimensions and
 *    the header persona switcher (`ScopeSwitcherVM`).
 *  - `DecimalValue` scalar kind (PRODUCTIVITY 9.7) and `DeltaVM.abs`
 *    (+RM 20,000 / +7 / +0.4) with `DeltaVM.display` selector.
 *  - Dashboard: `focusMetrics` card row ("Other Focus Metrics (2)"),
 *    `moreActions` sheet (Set Goals / Customize / History), expanded
 *    `RecommendationsPanelVM` (AI panel).
 *  - Metric detail: `BarComparisonSectionVM` (Manpower / New Recruit bars).
 *  - History: `window` (CURRENT_YEAR|VS_LAST_YEAR|VS_LAST_2_YEARS),
 *    `momDeltas` column, `moreTabs` overflow.
 *
 * v1.2.0 CHANGES (P4 uplift, all additive):
 *  - MetricDetailVM: `dataState` (OK|PROCESSING|EMPTY full-screen states)
 *    and `notices[]` (dismissible data-gap banners).
 *  - Period selector is a bottom sheet; `filters.periodOptionsMeta` carries
 *    each option's window start ("MTD · 1 Jul 2026 – Today"). MTD in MY.
 *  - MoM column header follows the metric's `display`
 *    (PCT → "MoM % Change", else "MoM Delta").
 *
 * v1.6.0 CHANGES (S-P4-02 v1.13.0, ARVIJ-159 Team Manpower — additive):
 *  - `BarComparisonSectionVM.layout?` ('GROUPED' | 'STACKED', default
 *    GROUPED) and `BarComparisonSectionVM.totals?` (required when STACKED).
 *    MANPOWER now emits STACKED EXISTING_AGENTS + NEW_RECRUITS (superseding
 *    grouped OPENING/CLOSING); the per-year total and its delta chip come
 *    from `totals[]`, never summed client-side. NEW_RECRUIT_CONTRACTED is
 *    unaffected (layout absent ⇒ GROUPED rules, single measure).
 *  - Semantics only: MANPOWER `DeltaVM.display` is PCT (catalog flip from
 *    ABS) and its `pct` follows the shared round-away-from-zero rule
 *    (widget-contracts.md §2 `R-PCT-ROUNDUP`) — applied by the producer.
 *
 * v1.4.0 CHANGES (desktop layout, screenshot-derived — legacy-contract.md A6/A7):
 *  - `focusMetrics` becomes `{ visible, addEnabled, items }` (was a bare
 *    array) — BREAKING. `addEnabled` drives a "+" affordance when `items=[]`
 *    and `visible=true` (was: hide entirely when empty, AC-P4-01-17→26/27).
 *  - No new fields for the desktop Filter action / summary pills — the BFF
 *    contract (`filters.*`) is unchanged; only the UI's presentation of the
 *    existing period/businessLine/basis/teamView filters differs at ≥1024px
 *    (AC-P4-01-28/29).
 *
 * v1.3.0 CHANGES (rulings 2026-08 — no type changes, semantics only):
 *  - `basis` is an AGENT-SEGMENT lens: SCHEME = Prudential-employed
 *    full-time agents. Toggling re-composes priority/focus sets, ordering
 *    and goals from catalog `segmentOverrides`; card lists may differ
 *    between STANDARD and SCHEME payloads.
 *  - `basisToggleVisible` / `teamViewToggleVisible` are computed by the BFF
 *    as config flag AND caller entitlement: the Group toggle renders only
 *    for P2-level leaders (P3 = DIRECT-only; API 403s GROUP for P3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULES (mirror repo decisions D-03/D-04/D-05/D-08)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. VMs carry DATA + SEMANTICS only — never presentation strings.
 *    Labels resolve in the UI from codes via i18n (`insights.metric.TPC.title`,
 *    `insights.variant.WITHOUT_REPRICING`, `insights.delta.vsLY`, …).
 * 2. Money stays a decimal string; DLS `formatMoney(scalar, locale)` renders it.
 * 3. `sentiment` arrives from the domain; UI maps it to DLS tone tokens
 *    (POSITIVE → tone.success, NEGATIVE → tone.danger, NEUTRAL → tone.muted).
 * 4. Section/`card` composition is decided by the BFF from config (C4) +
 *    metric capabilities; the UI renders `sections[]` in order and never
 *    re-derives layout. Unknown section/card types must be skipped (forward
 *    compatibility).
 * 5. Every VM includes `meta` for cache/version/trace plumbing.
 */
export {};
