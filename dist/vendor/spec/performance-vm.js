/**
 * PRUAction — Performance (P4) View Models
 * Contract C3: Next.js BFF → UI (CDK widgets)
 *
 * @version 1.8.0  (S-P4-07 "My Team" + dashboard viewing mode — see CHANGES below)
 * @module domains/insights/bff/performance-vm
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
 * | GET  /api/bff/v1/performance/team-drilldown         | TeamDrilldownVM        | listTeamMembers (+ getTeamMemberDashboard when           |
 * |        ?teamView&basis&query&sortBy&badges          |                        |   selectedAgentId) + team-drilldown config (C4)          |
 * |        &parentAgentId&period&businessLine           |                        |                                                         |
 * |        &performanceBasis&selectedAgentId            |                        |                                                         |
 * | GET  /api/bff/v1/performance/dashboard              | PerformanceDashboardVM | as above, for `subjectAgentId` after proving it is in   |
 * |        …&subjectAgentId (v1.8.0 viewing mode)       |   + `viewing`          |   the caller's downline (else 403 BFF-4033)             |
 *
 * v1.8.0 CHANGES (SPEC-2026-004 · S-P4-07 0.2.0 + S-P4-01 2.1.0):
 *  - BREAKING (DRAFT S-P4-07 surface only): `TeamDrilldownFiltersVM.basis`
 *    becomes optional — absent means all hierarchy levels. Everything else
 *    below is additive.
 *  - Team Drilldown "My Team" card data: optional `TeamMemberVM.badges`,
 *    `goalStatus`, `tpc`, `ptpc`, `directReportCount`, `photoUrl`, `nav`.
 *  - `TeamDrilldownVM.summary` (KPI tiles over the FILTERED set, D-P4-07-02),
 *    `parent` (subteam drawer header) and `filterOptions` (Sort By + badge
 *    groups from C4). Filters gain `sortBy`, `badges`, `parentAgentId`.
 *  - `PerformanceDashboardVM.viewing` — a leader viewing a downline member's
 *    dashboard ("Viewing {name}" banner + Exit View). Scope follows the
 *    member's role (D-P4-07-03); read-only.
 *  - Member card fields have no approved upstream source (OQ-79): the BFF
 *    omits them in source mode and never synthesizes them.
 *
 * v1.5.1 CHANGES (closes README `OQ-25` — SPEC-2026-003, no shape change):
 *  - `MetricCardVM.valueDisplay` was recorded in v1.5.1 documenting a field
 *    the shipped app already consumed, without approving an abbreviation
 *    policy. That policy is now decided: `w.metric.card` (S-P4-01) renders
 *    every MONEY value compact regardless of this field; the field still
 *    governs COUNT/PERCENT/DECIMAL (default FULL) and is otherwise unused.
 *    See the field's own doc comment and widget-contracts.md.
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
 * v1.5.0 CHANGES (upstream source onboarding — data/source-mapping.md C0):
 *  - `MetricCardVM.value` becomes OPTIONAL and `dataState`
 *    (OK|PROCESSING|EMPTY, default OK) is added — BREAKING for consumers:
 *    they MUST handle an absent `value` when `dataState !== 'OK'`.
 *    Rationale: a catalogued metric may have no approved upstream source
 *    (e.g. FYC arrives typed null). Such a card is emitted with its
 *    `metricCode`, `valueType` and `nav` intact so the metric stays visible
 *    and navigable, instead of being silently dropped from the dashboard.
 *    Mirrors the `MetricDetailVM.dataState` vocabulary added in v1.2.0.
 *  - `MetricCardVM.notices?` — same `NoticeVM` shape the detail screen uses,
 *    for per-card data-gap messaging (e.g. a missing product feed).
 *  - No layer may substitute a zero or synthesized value for a missing one
 *    (C1 §7.12).
 *
 * v1.7.0 CHANGES (S-P4-02 v1.19.0, Penders card link — additive):
 *  - `PendersSectionVM.nav?: RouteRef` (optional). A placeholder for the
 *    Activity Management Proposal-screen link. The destination is still
 *    open (`OQ-30`), so the BFF MUST omit it until that is answered. The UI
 *    renders the link face either way and navigates only when `nav` is
 *    present (`AC-P4-02-56`/`-57`).
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
